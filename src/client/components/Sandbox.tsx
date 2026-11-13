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
import { api } from '../api'
import type { ProbeMetrics } from '../types'

export interface SandboxHandle {
  probe: () => Promise<ProbeMetrics | null>
  reload: () => void
  startPick: () => void
}

interface Props {
  html: string
  initData: Record<string, string>
  scope: { kind: 'project'; projectId: string } | { kind: 'share'; slug: string }
  onConsole?: (level: 'info' | 'error' | 'warn', text: string) => void
  onPick?: (picked: { selector: string; tag: string; text: string; html?: string }) => void
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
  { html, initData, scope, onConsole, onPick },
  ref,
) {
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const [reloadKey, setReloadKey] = useState(0)
  const probeRef = useRef<{
    id: string
    resolve: (m: ProbeMetrics | null) => void
    timer: ReturnType<typeof setTimeout>
  } | null>(null)
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

  useEffect(() => {
    setReloadDoc(null)
  }, [html])

  const srcDoc = useMemo(
    () => reloadDoc ?? buildSrcDoc(html, initData, SANDBOX_RUNTIME),
    [html, initData, reloadDoc],
  )

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const iframe = iframeRef.current
      if (!iframe || event.source !== iframe.contentWindow) return
      const data = event.data
      if (!data || typeof data !== 'object') return

      if (data.type === 'atoms-kv' && Array.isArray(data.ops)) {
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
      if (data.type === 'atoms-picked') {
        pickRef.current?.({ selector: data.selector, tag: data.tag, text: data.text })
        return
      }
      if (data.type === 'atoms-ready') {
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
  }))

  return (
    <iframe
      key={reloadKey}
      ref={iframeRef}
      title="应用预览"
      srcDoc={srcDoc}
      sandbox="allow-scripts allow-forms allow-modals allow-downloads"
      className="h-full w-full border-0 bg-white"
      onLoad={() => consoleRef.current?.('info', '预览已加载')}
    />
  )
})

export default Sandbox
export { buildSrcDoc }
