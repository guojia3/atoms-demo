// OpenAI 兼容 /chat/completions 客户端：流式、超时、供应商回退、截断识别
import { config, isMockMode, type Provider } from '../config.js'

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface StreamResult {
  text: string
  model: string
  provider: string
  fallbackUsed: boolean
  truncated: boolean
}

const TOTAL_TIMEOUT_MS = 300_000
const IDLE_TIMEOUT_MS = 60_000

function pickProviders(preferredModel?: string): Provider[] {
  const list = [...config.providers]
  if (preferredModel) {
    const idx = list.findIndex((p) => p.model === preferredModel || p.name === preferredModel)
    if (idx > 0) list.unshift(list.splice(idx, 1)[0])
  }
  return list
}

async function requestOnce(
  provider: Provider,
  messages: ChatMessage[],
  onDelta: (text: string) => void,
  outerSignal: AbortSignal,
): Promise<{ text: string; truncated: boolean }> {
  const controller = new AbortController()
  const abortFromOuter = () => controller.abort()
  if (outerSignal.aborted) abortFromOuter()
  else outerSignal.addEventListener('abort', abortFromOuter)

  let idleTimer: ReturnType<typeof setTimeout> | null = null
  let idleExpired = false
  const touchIdle = () => {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      idleExpired = true
      controller.abort()
    }, IDLE_TIMEOUT_MS)
  }

  const res = await fetch(`${provider.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {}),
    },
    body: JSON.stringify({
      model: provider.model,
      messages,
      stream: true,
      temperature: 0.4,
      max_tokens: 8000,
    }),
    signal: controller.signal,
  })

  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    const err = new Error(`模型接口 ${res.status}: ${detail.slice(0, 300)}`)
    ;(err as Error & { status?: number }).status = res.status
    throw err
  }
  if (!res.body) throw new Error('模型接口未返回流式响应')

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let text = ''
  let truncated = false

  try {
    touchIdle()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      touchIdle()
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''
      for (const rawLine of lines) {
        const line = rawLine.trim()
        if (!line || !line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (payload === '[DONE]') continue
        let json: any
        try {
          json = JSON.parse(payload)
        } catch {
          continue
        }
        const choice = json.choices?.[0]
        if (!choice) continue
        if (choice.finish_reason === 'length') truncated = true
        const delta = choice.delta?.content
        if (typeof delta === 'string' && delta.length > 0) {
          text += delta
          onDelta(delta)
        }
      }
    }
  } catch (err) {
    if (idleExpired) throw new Error(`模型响应空闲超时（${IDLE_TIMEOUT_MS / 1000}s）`)
    throw err
  } finally {
    if (idleTimer) clearTimeout(idleTimer)
    outerSignal.removeEventListener('abort', abortFromOuter)
    try {
      reader.releaseLock()
    } catch {
      /* noop */
    }
  }

  if (truncated && text.length < 4000) {
    throw new Error('模型输出被截断（finish_reason=length）')
  }
  if (!text.trim()) throw new Error('模型返回空内容')
  return { text, truncated }
}

/** 依次尝试供应商；仅在"尚未产出任何内容"时切换供应商，避免半截内容混拼 */
export async function streamChat(
  messages: ChatMessage[],
  onDelta: (delta: string, meta: { model: string; chars: number }) => void,
  preferredModel?: string,
): Promise<StreamResult> {
  if (isMockMode() || config.providers.length === 0) {
    throw new Error('MOCK_MODE 下不应调用模型')
  }
  let lastError: Error | null = null
  let sawDelta = false
  let totalText = ''

  for (const provider of pickProviders(preferredModel)) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const controller = new AbortController()
      const totalTimer = setTimeout(() => controller.abort(), TOTAL_TIMEOUT_MS)
      let firstChunk = true
      try {
        const result = await requestOnce(
          provider,
          messages,
          (delta) => {
            sawDelta = true
            firstChunk = false
            totalText += delta
            onDelta(delta, { model: provider.model, chars: totalText.length })
          },
          controller.signal,
        )
        return {
          text: result.text,
          model: provider.model,
          provider: provider.name,
          fallbackUsed: false,
          truncated: result.truncated,
        }
      } catch (err) {
        lastError = err as Error
        const status = (err as Error & { status?: number }).status
        // 已经产生内容说明是中途失败，直接抛错交给上层降级，避免重复生成
        if (sawDelta && totalText.length > 0) throw lastError
        const retryable = !status || status === 429 || status >= 500 || status === 0
        if (attempt === 0 && retryable && firstChunk) {
          await new Promise((r) => setTimeout(r, 600))
          continue
        }
        break // 换下一个供应商
      } finally {
        clearTimeout(totalTimer)
      }
    }
  }
  throw lastError || new Error('所有模型供应商均不可用')
}
