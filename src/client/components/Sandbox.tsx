// 沙箱预览：无同源 iframe + 注入 CSP + 运行时（存储替身 / 错误采集 / 探针）
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react'
import { SANDBOX_RUNTIME } from '../../shared/runtime'
import { chooseQaCases, buildRetestPlan, type QaCaseKind, type QaFeatures, type QaReport } from '../../shared/qa'
import { api } from '../api'
import type { ProbeMetrics } from '../types'

export interface SandboxHandle {
  probe: () => Promise<ProbeMetrics | null>
  reload: () => void
  startPick: () => void
  runQa: (mode?: 'full' | 'retest' | 'persistence', focus?: QaCaseKind[]) => Promise<QaReport | null>
}

interface QaProgress {
  index: number
  total: number
  passed: number
  failed: number
  title: string
  status: 'passed' | 'failed'
}

interface Props {
  html: string
  initData: Record<string, string>
  scope: { kind: 'project'; projectId: string } | { kind: 'share'; slug: string }
  onConsole?: (level: 'info' | 'error' | 'warn', text: string) => void
  onPick?: (picked: { selector: string; tag: string; text: string; html?: string }) => void
  /** 内容自适应高度：运行时上报 scrollHeight 后撑开 iframe（仅分享页使用，工作台预览保持 h-full） */
  autoHeight?: boolean
  /** 是否把沙箱内的存储写入同步到服务端；隐藏的并行探针沙箱关闭，避免污染项目数据 */
  syncKv?: boolean
  /** 关闭同步时，把写入批次交给宿主缓存（用于候选预览定稿后合并） */
  onKvOps?: (ops: Array<{ op: string; key: string; value?: string }>) => void
  /** QA 每条用例执行后的进度（仅当前活动的隐藏 QA 沙箱） */
  onQaProgress?: (p: QaProgress) => void
}

const CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' 'unsafe-eval'",
  "style-src 'unsafe-inline'",
  'img-src data: blob:',
  'font-src data:',
  'media-src data: blob:',
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join('; ')

function buildSrcDoc(html: string, initData: Record<string, string>, runtime: string): string {
  const initJson = JSON.stringify({ data: initData }).replace(/</g, '\\u003c')
  const head = [
    `<meta http-equiv="Content-Security-Policy" content="${CSP}">`,
    `<script>window.__ATOMS_INIT__=${initJson}</script>`,
    `<script>${runtime}</script>`,
  ].join('\n')
  if (!html) {
    return `<!DOCTYPE html><html><head>${head}</head><body><div style="font-family:-apple-system,sans-serif;padding:24px;color:#71717a">等待生成…</div></body></html>`
  }
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (m) => `${m}\n${head}`)
  if (/<html[^>]*>/i.test(html)) return html.replace(/<html[^>]*>/i, (m) => `${m}\n<head>${head}</head>`)
  return `<!DOCTYPE html><html><head>${head}</head><body>${html}</body></html>`
}

const Sandbox = forwardRef<SandboxHandle, Props>(function Sandbox(
  { html, initData, scope, onConsole, onPick, autoHeight = false, syncKv = true, onKvOps, onQaProgress },
  ref,
) {
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const [reloadKey, setReloadKey] = useState(0)
  const probeRef = useRef<{
    id: string
    resolve: (m: ProbeMetrics | null) => void
    timer: ReturnType<typeof setTimeout>
  } | null>(null)
  const qaRef = useRef<{
    id: string
    resolve: (report: QaReport | null) => void
    timer: ReturnType<typeof setTimeout>
  } | null>(null)
  const qaModeRef = useRef<'full' | 'retest' | 'persistence'>('full')
  const qaFocusRef = useRef<QaCaseKind[]>([])
  const readyRef = useRef(false)
  const qaProgressRef = useRef(onQaProgress)
  qaProgressRef.current = onQaProgress
  const consoleRef = useRef(onConsole)
  const pickRef = useRef(onPick)
  consoleRef.current = onConsole
  pickRef.current = onPick
  const scopeRef = useRef(scope)
  scopeRef.current = scope
  const initRef = useRef(initData)
  initRef.current = initData
  const htmlRef = useRef(html)
  htmlRef.current = html
  const [reloadDoc, setReloadDoc] = useState<string | null>(null)
  const autoHeightRef = useRef(autoHeight)
  autoHeightRef.current = autoHeight
  const syncKvRef = useRef(syncKv)
  syncKvRef.current = syncKv
  const kvOpsRef = useRef(onKvOps)
  kvOpsRef.current = onKvOps
  // 自适应高度：初始给一个可测量的高度，运行时上报后按内容撑开
  const [frameHeight, setFrameHeight] = useState(480)

  useEffect(() => {
    setReloadDoc(null)
    setFrameHeight(480)
  }, [html])

  const srcDoc = useMemo(
    () => reloadDoc ?? buildSrcDoc(html, initData, SANDBOX_RUNTIME),
    [html, initData, reloadDoc],
  )

  useEffect(() => {
    // srcDoc 变化（含 QA 刷新验证的 initData 变化）意味着文档重载，运行时需要重新上报 ready
    readyRef.current = false
  }, [srcDoc])

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const iframe = iframeRef.current
      if (!iframe || event.source !== iframe.contentWindow) return
      const data = event.data
      if (!data || typeof data !== 'object') return

      if (data.type === 'atoms-height') {
        if (!autoHeightRef.current) return
        const height = Math.round(Number(data.height))
        if (!Number.isFinite(height) || height <= 0) return
        setFrameHeight((prev) => (Math.abs(prev - height) <= 1 ? prev : height))
        return
      }
      if (data.type === 'atoms-kv' && Array.isArray(data.ops)) {
        if (!syncKvRef.current) {
          kvOpsRef.current?.(data.ops)
          return
        }
        const currentScope = scopeRef.current
        const path =
          currentScope.kind === 'project' ? `/api/projects/${currentScope.projectId}/kv` : `/api/share/${currentScope.slug}/kv`
        api(path, { method: 'POST', body: { ops: data.ops } }).catch((err) => {
          consoleRef.current?.('warn', `数据同步失败：${(err as Error).message}`)
        })
        return
      }
      if (data.type === 'atoms-error') {
        consoleRef.current?.('error', `${data.message}${data.source ? `（${data.source}）` : ''}`)
        return
      }
      if (data.type === 'atoms-probe-result') {
        const pending = probeRef.current
        if (pending && pending.id === data.id) {
          clearTimeout(pending.timer)
          probeRef.current = null
          pending.resolve(data.metrics as ProbeMetrics)
        }
        return
      }
      if (data.type === 'atoms-qa-inventory') {
        const pending = qaRef.current
        if (pending && pending.id === data.id) {
          const features = data.features as QaFeatures
          const cases =
            qaModeRef.current === 'retest'
              ? buildRetestPlan(qaFocusRef.current)
              : qaModeRef.current === 'persistence'
                ? [
                    {
                      kind: 'persistence' as const,
                      title: '刷新后数据仍在',
                      reload: true,
                      expectItems: Number(features?.itemCount || 0) > 0 || Boolean(features?.listLike),
                    },
                  ]
                : chooseQaCases(features)
          iframe.contentWindow?.postMessage({ type: 'atoms-qa-plan', id: data.id, cases }, '*')
        }
        return
      }
      if (data.type === 'atoms-qa-wait') {
        // QA 沙箱离屏渲染，iframe 内 setTimeout 会被钳制到 1s；由可见的父页面计时后回传
        const ms = Math.max(0, Math.min(2000, Number(data.ms) || 0))
        const id = String(data.id || '')
        setTimeout(() => iframe.contentWindow?.postMessage({ type: 'atoms-qa-tick', id }, '*'), ms)
        return
      }
      if (data.type === 'atoms-qa-progress') {
        qaProgressRef.current?.({
          index: Number(data.index || 0),
          total: Number(data.total || 0),
          passed: Number(data.passed || 0),
          failed: Number(data.failed || 0),
          title: String(data.title || ''),
          status: data.status === 'failed' ? 'failed' : 'passed',
        })
        return
      }
      if (data.type === 'atoms-qa-result') {
        const pending = qaRef.current
        if (pending && pending.id === data.id) {
          clearTimeout(pending.timer)
          qaRef.current = null
          const cases = Array.isArray(data.cases) ? data.cases : []
          pending.resolve({
            status: cases.some((c: { status: string }) => c.status === 'failed') ? 'failed' : 'passed',
            cases,
            total: cases.length,
            passed: cases.filter((c: { status: string }) => c.status === 'passed').length,
            failed: cases.filter((c: { status: string }) => c.status === 'failed').length,
            durationMs: Number(data.durationMs || 0),
            width: Number(data.width || 0),
          })
        }
        return
      }
      if (data.type === 'atoms-picked') {
        pickRef.current?.({ selector: data.selector, tag: data.tag, text: data.text })
        return
      }
      if (data.type === 'atoms-ready') {
        readyRef.current = true
        consoleRef.current?.('info', `沙箱运行时就绪${data.title ? `：${data.title}` : ''}`)
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [])

  useImperativeHandle(ref, () => ({
    probe: () =>
      new Promise<ProbeMetrics | null>((resolve) => {
        const iframe = iframeRef.current
        if (!iframe?.contentWindow) {
          resolve(null)
          return
        }
        if (probeRef.current) {
          clearTimeout(probeRef.current.timer)
          probeRef.current.resolve(null)
          probeRef.current = null
        }
        const id = Math.random().toString(36).slice(2)
        const timer = setTimeout(() => {
          if (probeRef.current?.id === id) {
            probeRef.current = null
            resolve(null)
          }
        }, 9000)
        probeRef.current = { id, resolve, timer }
        iframe.contentWindow.postMessage({ type: 'atoms-probe', id }, '*')
      }),
    reload: () => {
      // 刷新前先拉取服务端最新 KV，避免把用户刚写入的数据回滚成初始快照
      const currentScope = scopeRef.current
      const path =
        currentScope.kind === 'project' ? `/api/projects/${currentScope.projectId}/kv` : `/api/share/${currentScope.slug}/kv`
      setTimeout(() => {
        api<{ data: Record<string, string> }>(path)
          .then((res) => setReloadDoc(buildSrcDoc(htmlRef.current, res.data || {}, SANDBOX_RUNTIME)))
          .catch(() => setReloadDoc(buildSrcDoc(htmlRef.current, initRef.current, SANDBOX_RUNTIME)))
          .finally(() => setReloadKey((k) => k + 1))
      }, 350)
    },
    startPick: () => {
      iframeRef.current?.contentWindow?.postMessage({ type: 'atoms-pick-start' }, '*')
    },
    runQa: (mode: 'full' | 'retest' | 'persistence' = 'full', focus: QaCaseKind[] = []) =>
      new Promise<QaReport | null>((resolve) => {
        const iframe = iframeRef.current
        if (!iframe?.contentWindow) {
          resolve(null)
          return
        }
        if (qaRef.current) {
          clearTimeout(qaRef.current.timer)
          qaRef.current.resolve(null)
          qaRef.current = null
        }
        const id = Math.random().toString(36).slice(2)
        qaModeRef.current = mode
        qaFocusRef.current = focus
        const timer = setTimeout(() => {
          if (qaRef.current?.id === id) {
            qaRef.current = null
            resolve(null)
          }
        }, 20000)
        qaRef.current = { id, resolve, timer }
        // iframe 可能尚未完成运行时注入：等 ready 后再发起点，最多等 4s
        const deadline = Date.now() + 4000
        const start = () => {
          if (qaRef.current?.id !== id) return
          if (!readyRef.current) {
            if (Date.now() >= deadline) {
              clearTimeout(timer)
              qaRef.current = null
              resolve(null)
              return
            }
            setTimeout(start, 120)
            return
          }
          iframe.contentWindow?.postMessage({ type: 'atoms-qa-start', id }, '*')
        }
        start()
      }),
  }))

  return (
    <iframe
      key={reloadKey}
      ref={iframeRef}
      title="应用预览"
      srcDoc={srcDoc}
      sandbox="allow-scripts allow-forms allow-downloads"
      className={`w-full border-0 bg-white ${autoHeight ? 'block' : 'h-full'}`}
      style={autoHeight ? { height: `${frameHeight}px` } : undefined}
      onLoad={() => consoleRef.current?.('info', '预览已加载')}
    />
  )
})

export default Sandbox
export { buildSrcDoc }
