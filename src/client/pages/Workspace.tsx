import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import Sandbox, { type SandboxHandle } from '../components/Sandbox'
import { api, downloadHtml } from '../api'
import type {
  ConsoleEntry,
  Message,
  PickTarget,
  Plan,
  ProbeMetrics,
  ProjectDetail,
  Report,
  StepState,
  User,
} from '../types'

const PROBE_DELAY_MS = 1600
const STEP_ORDER = ['plan', 'generate', 'verify', 'review', 'deliver'] as const
const STEP_DEFAULT: Record<string, string> = {
  plan: 'Mike 拆解需求',
  generate: 'Alex 生成页面',
  verify: '静态检查 + 浏览器实测',
  review: '逐条验收',
  deliver: '保存版本与结论',
}

interface Props {
  user: User | null
}

interface CandidateReady {
  id: string
  model?: string
  source?: string
}

function shortModel(model?: string | null): string {
  if (!model) return '—'
  return model.length > 18 ? `${model.slice(0, 16)}…` : model
}

function ScoreRing({ score, size = 44 }: { score: number | null; size?: number }) {
  const value = Math.max(0, Math.min(100, score ?? 0))
  const color = value >= 85 ? '#059669' : value >= 70 ? '#4f46e5' : value >= 50 ? '#d97706' : '#dc2626'
  return (
    <div
      className="grid shrink-0 place-items-center rounded-full border-2 bg-white"
      style={{ width: size, height: size, borderColor: color }}
    >
      <span className="text-[15px] font-semibold" style={{ color }}>
        {score ?? '—'}
      </span>
    </div>
  )
}

function PlanCard({ plan }: { plan: Plan }) {
  return (
    <div className="animate-fade-up rounded-2xl border border-indigo-100 bg-indigo-50/40 p-4">
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="text-[11px] font-medium uppercase tracking-wide text-indigo-500">需求拆解 · Mike</div>
          <h3 className="mt-1 text-[15px] font-semibold text-neutral-900">{plan.title}</h3>
        </div>
        <span className="rounded-full bg-white px-2 py-0.5 text-[10px] text-indigo-500 ring-1 ring-indigo-100">
          {plan.source === 'model' ? '模型规划' : '内置方案'}
        </span>
      </div>
      <p className="mt-2 text-[12px] leading-5 text-neutral-600">{plan.summary}</p>
      {plan.notes && <p className="mt-1 text-[11px] text-amber-600">{plan.notes}</p>}
      <div className="mt-3 flex flex-wrap gap-1.5">
        {plan.features.slice(0, 5).map((f) => (
          <span key={f} className="rounded-md bg-white px-2 py-1 text-[11px] text-neutral-600 ring-1 ring-neutral-200">
            {f}
          </span>
        ))}
      </div>
      <div className="mt-3 rounded-xl bg-white/70 p-3 ring-1 ring-indigo-100">
        <div className="text-[11px] font-medium text-neutral-500">验收清单（{plan.checklist.length} 条）</div>
        <ul className="mt-1.5 space-y-1">
          {plan.checklist.map((c, i) => (
            <li key={c.id} className="flex gap-1.5 text-[11px] leading-5 text-neutral-600">
              <span className="text-neutral-400">{i + 1}.</span>
              {c.text}
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}

function ReportCard({ report, onFix }: { report: Report; onFix?: () => void }) {
  const [expanded, setExpanded] = useState(false)
  const passed = report.score >= 70
  const checklist = report.checklist || []
  const probe = report.probe || []
  const staticItems = report.static?.items || []
  const failedStatic = staticItems.filter((i) => !i.pass)
  const passCount = checklist.filter((i) => i.pass).length

  return (
    <div className="animate-fade-up overflow-hidden rounded-2xl border border-neutral-200 bg-white">
      <div className="flex items-center gap-3 border-b border-neutral-100 bg-neutral-50/70 px-4 py-3">
        <ScoreRing score={report.score} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[14px] font-semibold text-neutral-900">验收报告</span>
            <span
              className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
                passed ? 'bg-emerald-50 text-emerald-600' : 'bg-amber-50 text-amber-600'
              }`}
            >
              {passed ? '已通过' : '待修复'}
            </span>
          </div>
          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-neutral-500">
            <span>静态 {report.parts.static}/10</span>
            <span>实测 {report.parts.probe}/50</span>
            <span>清单 {report.parts.checklist}/40</span>
            <span>通过 {passCount}/{checklist.length}</span>
          </div>
        </div>
        {onFix && (!passed || checklist.some((i) => !i.pass)) && (
          <button
            onClick={onFix}
            className="shrink-0 rounded-lg bg-indigo-600 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-indigo-700"
          >
            一键修复
          </button>
        )}
        <button onClick={() => setExpanded((v) => !v)} className="shrink-0 text-[11px] text-indigo-600 hover:underline">
          {expanded ? '收起' : '完整报告'}
        </button>
      </div>

      {report.race && report.race.length > 1 && (
        <div className="flex flex-wrap items-center gap-1.5 border-b border-neutral-100 bg-neutral-50/60 px-4 py-2">
          <span className="text-[10px] text-neutral-400">双路赛马</span>
          {report.race.map((c) => (
            <span
              key={c.id}
              className={`rounded-full px-2 py-0.5 text-[10px] ${
                c.adopted
                  ? 'bg-emerald-50 font-medium text-emerald-700 ring-1 ring-emerald-200'
                  : 'bg-white text-neutral-500 ring-1 ring-neutral-200'
              }`}
              title={`${shortModel(c.model)} · ${c.parts.static}/10 + ${c.parts.probe}/50 + ${c.parts.checklist}/40`}
            >
              {c.label} · {c.score} 分{c.adopted ? '（采用）' : ''}
            </span>
          ))}
        </div>
      )}

      <div className="space-y-1.5 px-4 py-3">
        {checklist.map((item) => (
          <div key={item.id || item.text} className="flex items-start gap-2 text-[12px] leading-5">
            <span className={`mt-0.5 shrink-0 ${item.pass ? 'text-emerald-600' : 'text-red-500'}`}>{item.pass ? '✓' : '✕'}</span>
            <span className="min-w-0 flex-1 text-neutral-700">{item.text || item.label}</span>
            {!item.pass && <span className="hidden shrink-0 text-[11px] text-neutral-400 sm:inline">{item.evidence}</span>}
          </div>
        ))}
        {failedStatic.length > 0 && (
          <div className="text-[11px] text-amber-600">静态检查未通过：{failedStatic.map((i) => i.label).join('、')}</div>
        )}
      </div>

      {expanded && (
        <div className="space-y-3 border-t border-neutral-100 px-4 py-3">
          <div>
            <div className="mb-1 text-[11px] font-medium text-neutral-500">实测明细（沙箱探针）</div>
            {probe.map((item) => (
              <div key={item.key} className="flex items-start justify-between gap-3 py-1 text-[11px]">
                <div className="min-w-0">
                  <div className="text-neutral-700">
                    {item.label} <span className="text-neutral-400">{item.score}/{item.max}</span>
                  </div>
                  <div className="text-neutral-400">{item.evidence}</div>
                </div>
              </div>
            ))}
            {probe.length === 0 && <div className="text-[11px] text-neutral-400">未收到浏览器实测数据</div>}
          </div>
          <div>
            <div className="mb-1 text-[11px] font-medium text-neutral-500">验收清单证据</div>
            {checklist.map((item) => (
              <div key={`${item.id}-e`} className="py-1 text-[11px]">
                <span className={item.pass ? 'text-emerald-600' : 'text-red-500'}>{item.pass ? '通过' : '未通过'}</span>
                <span className="text-neutral-500"> · {item.text}</span>
                <div className="text-neutral-400">{item.evidence}</div>
              </div>
            ))}
          </div>
          <div>
            <div className="mb-1 text-[11px] font-medium text-neutral-500">静态完整性</div>
            {staticItems.map((item) => (
              <div key={item.key} className="flex justify-between gap-2 text-[11px] text-neutral-500">
                <span>
                  <span className={item.pass ? 'text-emerald-600' : 'text-red-500'}>{item.pass ? '✓' : '✕'}</span> {item.label}
                </span>
                <span className="text-neutral-400">{item.detail}</span>
              </div>
            ))}
          </div>
          {report.notes && report.notes.length > 0 && (
            <div className="rounded-lg bg-amber-50 px-2.5 py-2 text-[11px] text-amber-700">{report.notes.join('；')}</div>
          )}
          <div className="text-[10px] text-neutral-400">
            评分用于辅助择优：静态 10 + 浏览器实测 50 + 清单 40。清单判定来源：
            {report.reviewSource === 'model' ? '验收模型' : '可解释启发式'}。
          </div>
        </div>
      )}
    </div>
  )
}

function ActivityCard({
  steps,
  progress,
  runStatus,
}: {
  steps: Record<string, StepState>
  progress: { chars: number; tail: string } | null
  runStatus: string
}) {
  const visible = STEP_ORDER.filter((k) => steps[k] || runStatus === 'running')
  return (
    <div className="animate-fade-up rounded-2xl border border-neutral-200 bg-white p-4">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-medium uppercase tracking-wide text-neutral-400">
          {runStatus === 'running' ? '正在执行' : '执行记录'}
        </span>
        {runStatus === 'running' && (
          <span className="flex items-center gap-1.5 text-[11px] text-indigo-600">
            <span className="h-1.5 w-1.5 animate-pulse-dot rounded-full bg-indigo-500" />
            智能体工作中
          </span>
        )}
      </div>
      <ol className="mt-2.5 space-y-2">
        {visible.map((key) => {
          const step = steps[key] || { key, label: STEP_DEFAULT[key], status: 'running' as const }
          return (
            <li key={key} className="flex items-start gap-2.5">
              <span
                className={`mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-full text-[9px] ${
                  step.status === 'done'
                    ? 'bg-emerald-100 text-emerald-700'
                    : step.status === 'failed'
                      ? 'bg-red-100 text-red-600'
                      : 'bg-indigo-100 text-indigo-600'
                }`}
              >
                {step.status === 'done' ? '✓' : step.status === 'failed' ? '!' : '•'}
              </span>
              <div className="min-w-0">
                <div className="text-[12px] text-neutral-700">{step.label}</div>
                {step.detail && <div className="mt-0.5 text-[10px] leading-4 text-neutral-400">{step.detail}</div>}
              </div>
            </li>
          )
        })}
      </ol>
      {progress && runStatus === 'running' && (
        <div className="mt-3 rounded-lg bg-neutral-50 p-2.5">
          <div className="flex justify-between text-[10px] text-neutral-500">
            <span>流式生成中</span>
            <span>{progress.chars} 字符</span>
          </div>
          <div className="mt-1 h-1 overflow-hidden rounded-full bg-neutral-200">
            <div className="h-full w-1/2 animate-pulse rounded-full bg-indigo-500" />
          </div>
          <div className="mt-1.5 line-clamp-1 font-mono text-[10px] text-neutral-400">{progress.tail}</div>
        </div>
      )}
    </div>
  )
}

function MessageItem({ msg, onFix }: { msg: Message; onFix?: (report: Report) => void }) {
  if (msg.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl rounded-br-md bg-indigo-600 px-3.5 py-2.5 text-[12px] leading-5 text-white">
          {msg.content}
        </div>
      </div>
    )
  }
  if (msg.kind === 'plan') {
    const plan = (msg.meta?.plan || null) as Plan | null
    if (!plan) return null
    return <PlanCard plan={plan} />
  }
  if (msg.kind === 'report') {
    const report = msg.meta as Report
    if (!report || typeof report.score !== 'number') return null
    return <ReportCard report={report} onFix={onFix ? () => onFix(report) : undefined} />
  }
  if (msg.kind === 'version') {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-neutral-200 bg-neutral-50/80 px-3 py-2 text-[11px] text-neutral-500">
        <span className="grid h-5 w-5 place-items-center rounded-md bg-white text-indigo-600 ring-1 ring-neutral-200">✓</span>
        <span className="font-medium text-neutral-700">{msg.content}</span>
        {msg.meta?.score != null && <span className="text-neutral-400">· {msg.meta.score} 分</span>}
        {msg.meta?.model && <span className="ml-auto text-neutral-400">{shortModel(msg.meta.model)}</span>}
      </div>
    )
  }
  if (msg.kind === 'conclusion') {
    const passed = msg.meta?.status === 'passed'
    return (
      <div
        className={`animate-fade-up rounded-2xl border p-3.5 text-[12px] leading-5 ${
          passed ? 'border-emerald-200 bg-emerald-50/60 text-emerald-800' : 'border-amber-200 bg-amber-50/60 text-amber-800'
        }`}
      >
        <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide opacity-70">结论</div>
        {msg.content}
      </div>
    )
  }
  const system = msg.role === 'system'
  return (
    <div className="flex gap-2.5">
      <span className="grid h-6 w-6 shrink-0 place-items-center rounded-lg bg-gradient-to-br from-indigo-500 to-violet-600 text-[11px] font-bold text-white">
        A
      </span>
      <div className={`max-w-[90%] text-[12px] leading-5 ${system ? 'text-neutral-500' : 'text-neutral-700'}`}>
        {system ? <span className="rounded-lg bg-neutral-100 px-2.5 py-2">{msg.content}</span> : msg.content}
      </div>
    </div>
  )
}

export default function Workspace({ user }: Props) {
  const { id = '' } = useParams()
  const navigate = useNavigate()

  const [project, setProject] = useState<ProjectDetail | null>(null)
  const [previewHtml, setPreviewHtml] = useState('')
  const [kvData, setKvData] = useState<Record<string, string>>({})
  const [pickedTarget, setPickedTarget] = useState<PickTarget | null>(null)
  const [runStatus, setRunStatus] = useState<'idle' | 'running' | 'done' | 'failed' | 'stopped'>('idle')
  const [steps, setSteps] = useState<Record<string, StepState>>({})
  const [progress, setProgress] = useState<{ chars: number; tail: string } | null>(null)
  const [liveReport, setLiveReport] = useState<Report | null>(null)
  const [livePlan, setLivePlan] = useState<Plan | null>(null)
  const [liveConclusion, setLiveConclusion] = useState<string>('')
  const [consoleEntries, setConsoleEntries] = useState<ConsoleEntry[]>([])
  const [tab, setTab] = useState<'preview' | 'console' | 'code'>('preview')
  const [device, setDevice] = useState<'desktop' | 'mobile'>('desktop')
  const [mobilePane, setMobilePane] = useState<'chat' | 'preview'>('chat')
  const [input, setInput] = useState('')
  const [error, setError] = useState('')
  const [toast, setToast] = useState('')
  const [versionsOpen, setVersionsOpen] = useState(false)
  const [publishOpen, setPublishOpen] = useState(false)
  const [sharePath, setSharePath] = useState('')
  const [loading, setLoading] = useState(true)
  const [pickMode, setPickMode] = useState(false)

  const sandboxRef = useRef<SandboxHandle>(null)
  const streamAbortRef = useRef<AbortController | null>(null)
  const connectedRef = useRef<string | null>(null)
  const probedCandidates = useRef<Set<string>>(new Set())
  const previewInitializedRef = useRef(false)
  const messageScrollRef = useRef<HTMLDivElement>(null)
  const mountedRef = useRef(true)
  const projectIdRef = useRef(id)
  projectIdRef.current = id

  const showToast = (text: string) => {
    setToast(text)
    setTimeout(() => setToast(''), 2600)
  }

  const addConsole = (level: 'info' | 'error' | 'warn', text: string) => {
    setConsoleEntries((prev) => [...prev.slice(-120), { id: Math.random().toString(36).slice(2), level, text, at: new Date().toLocaleTimeString() }])
  }

  const loadKv = async (projectId: string) => {
    try {
      const res = await api<{ data: Record<string, string> }>(`/api/projects/${projectId}/kv`)
      setKvData(res.data || {})
    } catch {
      /* noop */
    }
  }

  const loadProject = async (projectId: string): Promise<ProjectDetail | null> => {
    const res = await api<{ project: ProjectDetail }>(`/api/projects/${projectId}`)
    const p = res.project
    setProject(p)
    if (!previewInitializedRef.current) {
      previewInitializedRef.current = true
      if (p.html) setPreviewHtml(p.html)
    }
    if (p.shareSlug && p.publishedVersionId) setSharePath(`/s/${p.shareSlug}`)
    await loadKv(projectId)
    return p
  }

  const refreshAfterRun = async () => {
    const projectId = projectIdRef.current
    try {
      const res = await api<{ project: ProjectDetail }>(`/api/projects/${projectId}`)
      setProject(res.project)
      if (res.project.shareSlug && res.project.publishedVersionId) setSharePath(`/s/${res.project.shareSlug}`)
      if (res.project.html) setPreviewHtml(res.project.html)
      await loadKv(projectId)
    } catch {
      /* noop */
    }
  }

  const handleCandidatesReady = async (list: CandidateReady[]) => {
    // 赛马：按候选顺序逐个切换预览并实测，避免多个探针同时争抢同一个 iframe
    for (const item of list) {
      if (!item?.id || probedCandidates.current.has(item.id)) continue
      probedCandidates.current.add(item.id)
      try {
        const res = await api<{ html: string }>(`/api/candidates/${item.id}/html`)
        setPreviewHtml(res.html)
        await loadKv(projectIdRef.current)
        addConsole('info', `${item.model || '候选'} 页面就绪（${Math.round((res.html.length / 1024) * 10) / 10}KB），开始浏览器实测…`)
        await new Promise((r) => setTimeout(r, PROBE_DELAY_MS))
        if (!mountedRef.current) return
        const metrics = await sandboxRef.current?.probe()
        if (!metrics) {
          addConsole('warn', `${item.model || '候选'} 实测未返回结果，按静态与清单估算`)
          continue
        }
        await api(`/api/candidates/${item.id}/report`, { method: 'POST', body: { metrics } })
        addConsole(
          'info',
          `${item.model || '候选'} 实测完成：${metrics.elements} 个元素 / 模拟点击 ${metrics.simulatedClicks ?? 0} 次 / 变化 ${
            metrics.simulatedChanges ?? 0
          } 次 / 报错 ${metrics.errorCount} 条 → 已上报`,
        )
      } catch (err) {
        addConsole('error', `实测或上报失败：${(err as Error).message}`)
      }
    }
  }

  const connect = async (runId: string) => {
    streamAbortRef.current?.abort()
    const controller = new AbortController()
    streamAbortRef.current = controller
    connectedRef.current = runId
    setRunStatus('running')
    setSteps({})
    setProgress(null)
    setLiveReport(null)
    setLivePlan(null)
    setLiveConclusion('')
    let lastSeq = 0
    let attempts = 0

    const runOnce = async (): Promise<void> => {
      const res = await fetch(`/api/runs/${runId}/events?from=${lastSeq}`, {
        credentials: 'same-origin',
        signal: controller.signal,
      })
      if (!res.ok || !res.body) throw new Error(`事件流连接失败（${res.status}）`)
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const blocks = buffer.split('\n\n')
        buffer = blocks.pop() || ''
        for (const block of blocks) {
          const dataLine = block
            .split('\n')
            .find((l) => l.startsWith('data:'))
          if (!dataLine) continue
          let event: { seq?: number; type?: string; data?: any }
          try {
            event = JSON.parse(dataLine.slice(5).trim())
          } catch {
            continue
          }
          if (typeof event.seq === 'number') lastSeq = Math.max(lastSeq, event.seq)
          if (!event.type) continue
          switch (event.type) {
            case 'snapshot': {
              const snap = event.data
              if (snap?.run?.status) {
                setRunStatus(snap.run.status === 'running' ? 'running' : (snap.run.status as any))
              }
              if (snap?.project && !projectIdRef.current) setProject(snap.project)
              break
            }
            case 'step': {
              const s = event.data as StepState
              setSteps((prev) => ({ ...prev, [s.key]: s }))
              break
            }
            case 'plan':
              setLivePlan(event.data?.plan || null)
              break
            case 'progress':
              setProgress({ chars: event.data?.chars || 0, tail: event.data?.tail || '' })
              break
            case 'candidate':
              break
            case 'candidates':
              void handleCandidatesReady((event.data?.candidates || []) as CandidateReady[])
              break
            case 'report':
              setLiveReport(event.data as Report)
              break
            case 'version':
              showToast(`已保存版本 v${event.data?.seq}${event.data?.score != null ? ` · ${event.data.score} 分` : ''}`)
              break
            case 'conclusion':
              setLiveConclusion(event.data?.content || '')
              break
            case 'error':
              setError(String(event.data?.message || '生成失败'))
              addConsole('error', String(event.data?.message || '生成失败'))
              break
            case 'done': {
              const status = String(event.data?.status || 'done') as any
              setRunStatus(status === 'running' ? 'done' : status)
              setProgress(null)
              await refreshAfterRun()
              break
            }
            default:
              break
          }
        }
      }
    }

    try {
      while (attempts < 3) {
        try {
          await runOnce()
          break
        } catch (err) {
          if ((err as Error).name === 'AbortError') return
          attempts += 1
          if (attempts >= 3) throw err
          await new Promise((r) => setTimeout(r, 800))
        }
      }
      await refreshAfterRun()
      setRunStatus((prev) => (prev === 'running' ? 'done' : prev))
    } catch (err) {
      if ((err as Error).name === 'AbortError') return
      setError(`事件流中断：${(err as Error).message}`)
      setRunStatus('failed')
    } finally {
      if (connectedRef.current === runId) connectedRef.current = null
    }
  }

  useEffect(() => {
    mountedRef.current = true
    previewInitializedRef.current = false
    probedCandidates.current.clear()
    setProject(null)
    setPreviewHtml('')
    setKvData({})
    setRunStatus('idle')
    setSteps({})
    setProgress(null)
    setLiveReport(null)
    setLivePlan(null)
    setLiveConclusion('')
    setConsoleEntries([])
    setError('')
    setSharePath('')
    setPickedTarget(null)
    setMobilePane('chat')
    setTab('preview')
    setLoading(true)

    let cancelled = false
    ;(async () => {
      try {
        const p = await loadProject(id)
        if (cancelled) return
        setLoading(false)
        if (p?.activeRunId) {
          void connect(p.activeRunId)
        }
      } catch (err) {
        if (!cancelled) {
          setError((err as Error).message)
          setLoading(false)
        }
      }
    })()

    return () => {
      cancelled = true
      mountedRef.current = false
      streamAbortRef.current?.abort()
      connectedRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  useEffect(() => {
    const el = messageScrollRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [project?.messages.length, runStatus, steps, liveReport, liveConclusion, livePlan])

  useEffect(() => {
    if (!toast) return
    const timer = setTimeout(() => setToast(''), 2600)
    return () => clearTimeout(timer)
  }, [toast])

  const send = async (override?: string, options?: { mode?: 'fix'; useTarget?: boolean }) => {
    const content = (override ?? input).trim()
    if (!content || runStatus === 'running' || !project) return
    if (override === undefined) setInput('')
    setError('')
    try {
      const res = await api<{ runId: string }>(`/api/projects/${project.id}/messages`, {
        method: 'POST',
        body: {
          content,
          ...(options?.mode ? { mode: options.mode } : {}),
          ...(options?.useTarget !== false && pickedTarget ? { target: pickedTarget } : {}),
        },
      })
      setPickedTarget(null)
      setProject((prev) =>
        prev
          ? {
              ...prev,
              messages: [
                ...prev.messages,
                {
                  id: `local-${Date.now()}`,
                  role: 'user',
                  kind: 'text',
                  content,
                  meta: null,
                  createdAt: new Date().toISOString(),
                },
              ],
            }
          : prev,
      )
      setLiveReport(null)
      setLivePlan(null)
      setLiveConclusion('')
      await connect(res.runId)
    } catch (err) {
      setError((err as Error).message)
      setInput(content)
    }
  }

  const fixReport = (report: Report) => {
    const failed = (report.checklist || [])
      .filter((i) => !i.pass)
      .map((i) => `- ${i.text || i.label || '验收项'}（${i.evidence || '未通过'}）`)
      .join('\n')
    const errors = consoleEntries
      .filter((e) => e.level === 'error')
      .slice(-3)
      .map((e) => `- ${e.text}`)
      .join('\n')
    const content = [
      '请修复以下问题，保持现有功能和数据结构不变：',
      failed || '- 验收清单存在未通过项',
      errors ? `运行报错：\n${errors}` : '',
    ]
      .filter(Boolean)
      .join('\n')
      .slice(0, 380)
    void send(content, { mode: 'fix', useTarget: false })
  }

  const stop = async () => {
    if (!project) return
    const active = connectedRef.current
    if (!active) return
    await api(`/api/runs/${active}/stop`, { method: 'POST' }).catch(() => {})
  }

  const publish = async () => {
    if (!project) return
    try {
      const res = await api<{ slug: string; path: string }>(`/api/projects/${project.id}/publish`, { method: 'POST' })
      setSharePath(res.path)
      setPublishOpen(true)
      await refreshAfterRun()
      showToast('已发布，链接已生成')
    } catch (err) {
      setError((err as Error).message)
    }
  }

  const unpublish = async () => {
    if (!project) return
    try {
      await api(`/api/projects/${project.id}/unpublish`, { method: 'POST' })
      setSharePath('')
      await refreshAfterRun()
      showToast('已下线')
    } catch (err) {
      setError((err as Error).message)
    }
  }

  const restore = async (versionId: string) => {
    if (!project) return
    try {
      await api(`/api/projects/${project.id}/versions/${versionId}/restore`, { method: 'POST' })
      setVersionsOpen(false)
      await refreshAfterRun()
      showToast('已恢复为新的当前版本')
    } catch (err) {
      setError((err as Error).message)
    }
  }

  const copyLink = async () => {
    if (!sharePath) return
    const url = `${location.origin}${sharePath}`
    try {
      await navigator.clipboard.writeText(url)
      showToast('链接已复制')
    } catch {
      showToast(url)
    }
  }

  const messages = project?.messages || []
  const running = runStatus === 'running'
  const shareUrl = sharePath ? `${location.origin}${sharePath}` : ''

  if (loading) {
    return (
      <div className="grid h-screen place-items-center bg-neutral-50">
        <div className="text-center">
          <div className="mx-auto h-7 w-7 animate-spin rounded-full border-2 border-neutral-200 border-t-indigo-500" />
          <p className="mt-3 text-[12px] text-neutral-500">加载项目…</p>
        </div>
      </div>
    )
  }

  if (!project) {
    return (
      <div className="grid h-screen place-items-center bg-neutral-50 px-6">
        <div className="max-w-sm text-center">
          <h1 className="text-[18px] font-semibold text-neutral-900">无法打开项目</h1>
          <p className="mt-2 text-[13px] text-neutral-500">{error || '项目不存在或不属于当前账号。'}</p>
          <Link to="/" className="mt-5 inline-block rounded-xl bg-indigo-600 px-4 py-2 text-[13px] font-medium text-white">
            返回首页
          </Link>
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-screen flex-col bg-neutral-100">
      {/* 顶部栏 */}
      <header className="flex h-14 shrink-0 items-center justify-between gap-2 border-b border-neutral-200 bg-white px-3 sm:px-5">
        <div className="flex min-w-0 items-center gap-2">
          <Link to="/" className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-neutral-500 hover:bg-neutral-100" title="返回首页">
            ←
          </Link>
          <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-gradient-to-br from-indigo-500 to-violet-600 text-[12px] font-bold text-white">
            A
          </span>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="truncate text-[14px] font-semibold text-neutral-900">{project.title}</h1>
              {project.currentVersionId && (
                <span className="hidden shrink-0 rounded-full bg-neutral-100 px-2 py-0.5 text-[10px] text-neutral-500 sm:inline">
                  v{project.versions[0]?.seq ?? 1}
                </span>
              )}
              {project.versions[0]?.score != null && (
                <span className="hidden shrink-0 rounded-full bg-indigo-50 px-2 py-0.5 text-[10px] font-medium text-indigo-600 sm:inline">
                  {project.versions[0].score} 分
                </span>
              )}
            </div>
            <div className="hidden truncate text-[10px] text-neutral-400 sm:block">
              {project.versions.length} 个版本 · 数据自动保存 · {user?.kind === 'guest' ? '游客模式' : user?.email}
            </div>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <button
            onClick={() => setVersionsOpen(true)}
            className="hidden rounded-lg border border-neutral-200 px-2.5 py-1.5 text-[12px] text-neutral-600 hover:bg-neutral-50 sm:inline"
          >
            版本历史
          </button>
          {sharePath ? (
            <button
              onClick={() => setPublishOpen(true)}
              className="rounded-lg border border-emerald-200 bg-emerald-50 px-2.5 py-1.5 text-[12px] font-medium text-emerald-700 hover:bg-emerald-100"
            >
              已发布
            </button>
          ) : (
            <button
              onClick={publish}
              disabled={!project.currentVersionId}
              className="rounded-lg bg-indigo-600 px-3 py-1.5 text-[12px] font-semibold text-white hover:bg-indigo-700 disabled:bg-neutral-300"
            >
              发布
            </button>
          )}
          <button
            onClick={() => downloadHtml(project.html, `${project.title}.html`)}
            disabled={!project.html}
            className="hidden rounded-lg border border-neutral-200 px-2.5 py-1.5 text-[12px] text-neutral-600 hover:bg-neutral-50 disabled:text-neutral-300 sm:inline"
          >
            导出
          </button>
        </div>
      </header>

      {/* 移动端切换 */}
      <div className="flex border-b border-neutral-200 bg-white md:hidden">
        {(['chat', 'preview'] as const).map((p) => (
          <button
            key={p}
            onClick={() => setMobilePane(p)}
            className={`flex-1 py-2 text-[12px] font-medium ${
              mobilePane === p ? 'border-b-2 border-indigo-500 text-indigo-600' : 'text-neutral-500'
            }`}
          >
            {p === 'chat' ? '对话 / 报告' : '预览'}
          </button>
        ))}
      </div>

      {error && (
        <div className="flex items-center justify-between gap-3 border-b border-red-100 bg-red-50 px-4 py-2 text-[12px] text-red-600">
          <span className="truncate">{error}</span>
          <button onClick={() => setError('')} className="shrink-0 text-red-400 hover:text-red-600">
            ✕
          </button>
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        {/* 左侧对话 */}
        <aside
          className={`${mobilePane === 'chat' ? 'flex' : 'hidden'} min-h-0 w-full flex-col border-r border-neutral-200 bg-white md:flex md:w-[400px] md:shrink-0`}
        >
          <div ref={messageScrollRef} className="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-3 py-4 sm:px-4">
            <div className="space-y-3">
              {messages.length === 0 && !running && !liveReport && (
                <div className="rounded-2xl border border-dashed border-neutral-200 bg-neutral-50/60 p-4 text-[12px] leading-5 text-neutral-500">
                  输入一句话开始生成。智能体会先给出需求拆解与验收清单，再生成可运行页面并逐条验收。
                </div>
              )}
              {messages.map((m) => (
                <MessageItem key={m.id} msg={m} onFix={fixReport} />
              ))}
              {running && (
                <>
                  {livePlan && messages.length === 0 && <PlanCard plan={livePlan} />}
                  <ActivityCard steps={steps} progress={progress} runStatus={runStatus} />
                </>
              )}
              {!running && liveReport && (
                <ReportCard report={liveReport} onFix={() => fixReport(liveReport)} />
              )}
              {!running && liveConclusion && (
                <div className="rounded-2xl border border-emerald-200 bg-emerald-50/60 p-3.5 text-[12px] leading-5 text-emerald-800">
                  {liveConclusion}
                </div>
              )}
              {progress && running && (
                <div className="text-[10px] text-neutral-400">
                  {shortModel(project.versions[0]?.model)}{progress.tail ? ` · ${progress.tail.slice(0, 60)}…` : ''}
                </div>
              )}
            </div>
          </div>

          <div className="shrink-0 border-t border-neutral-200 px-3 py-3 sm:px-4">
            {running ? (
              <div className="flex items-center justify-between gap-3 rounded-xl bg-neutral-50 px-3 py-2.5">
                <div className="flex items-center gap-2 text-[12px] text-neutral-500">
                  <span className="h-1.5 w-1.5 animate-pulse-dot rounded-full bg-indigo-500" />
                  任务执行中，完成后可继续迭代
                </div>
                <button
                  onClick={stop}
                  className="rounded-lg border border-neutral-200 bg-white px-2.5 py-1 text-[11px] font-medium text-neutral-600 hover:bg-neutral-100"
                >
                  停止
                </button>
              </div>
            ) : (
              <>
                <textarea
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send()
                  }}
                  rows={2}
                  maxLength={400}
                  placeholder="描述要改的地方，例如：主色改成绿色，底部增加一个统计栏"
                  className="w-full resize-none rounded-xl border border-neutral-200 px-3 py-2.5 text-[12px] leading-5 outline-none transition focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
                />
                <div className="mt-2 flex items-center justify-between">
                  <span className="min-w-0 truncate text-[10px] text-neutral-400">
                    {pickedTarget
                      ? `已点选 ${pickedTarget.tag}「${pickedTarget.text || pickedTarget.selector}」`
                      : '修改会生成新版本，失败不覆盖当前版本'}
                  </span>
                  <div className="flex shrink-0 items-center gap-1.5">
                    {pickedTarget && (
                      <button
                        onClick={() => setPickedTarget(null)}
                        className="rounded-md border border-neutral-200 px-1.5 py-0.5 text-[10px] text-neutral-500 hover:bg-neutral-50"
                      >
                        取消点选
                      </button>
                    )}
                    <button
                      onClick={() => send()}
                      disabled={input.trim().length < 2}
                      className="rounded-lg bg-indigo-600 px-3.5 py-1.5 text-[12px] font-semibold text-white hover:bg-indigo-700 disabled:bg-neutral-300"
                    >
                      发送
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>
        </aside>

        {/* 右侧预览 */}
        <main className={`${mobilePane === 'preview' ? 'flex' : 'hidden'} min-h-0 min-w-0 flex-1 flex-col md:flex`}>
          <div className="flex shrink-0 items-center justify-between gap-2 border-b border-neutral-200 bg-white px-3 py-2">
            <div className="flex items-center gap-1 rounded-lg bg-neutral-100 p-0.5">
              {(['desktop', 'mobile'] as const).map((d) => (
                <button
                  key={d}
                  onClick={() => setDevice(d)}
                  className={`rounded-md px-2.5 py-1 text-[11px] transition ${
                    device === d ? 'bg-white text-neutral-800 shadow-sm' : 'text-neutral-500'
                  }`}
                >
                  {d === 'desktop' ? '桌面' : '手机'}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-1.5">
              {pickMode && <span className="text-[10px] text-indigo-600">点选模式：点击页面元素</span>}
              <button
                onClick={() => {
                  setPickMode(true)
                  sandboxRef.current?.startPick()
                  setTimeout(() => setPickMode(false), 8000)
                }}
                className="rounded-lg border border-neutral-200 px-2 py-1 text-[11px] text-neutral-600 hover:bg-neutral-50"
                title="点选元素（P1 将用于局部修改）"
              >
                点选
              </button>
              <button
                onClick={() => sandboxRef.current?.reload()}
                className="rounded-lg border border-neutral-200 px-2 py-1 text-[11px] text-neutral-600 hover:bg-neutral-50"
              >
                刷新
              </button>
              <div className="flex items-center gap-0.5 rounded-lg bg-neutral-100 p-0.5">
                {(['preview', 'console', 'code'] as const).map((t) => (
                  <button
                    key={t}
                    onClick={() => setTab(t)}
                    className={`rounded-md px-2.5 py-1 text-[11px] transition ${
                      tab === t ? 'bg-white text-neutral-800 shadow-sm' : 'text-neutral-500'
                    }`}
                  >
                    {t === 'preview' ? '预览' : t === 'console' ? 'Console' : '代码'}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="scrollbar-thin relative min-h-0 flex-1 overflow-auto bg-neutral-100 p-3 sm:p-5">
            <div
              className={`mx-auto flex h-full flex-col overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-sm transition-all ${
                device === 'mobile' ? 'max-w-[390px]' : 'max-w-full'
              } ${tab === 'preview' ? '' : 'hidden'}`}
            >
              {previewHtml ? (
                <Sandbox
                  ref={sandboxRef}
                  html={previewHtml}
                  initData={kvData}
                  scope={{ kind: 'project', projectId: project.id }}
                  onConsole={(level, text) => {
                    if (level === 'error') addConsole('error', text)
                    else if (level === 'warn') addConsole('warn', text)
                    else addConsole('info', text)
                  }}
                  onPick={(picked) => {
                    setPickMode(false)
                    setPickedTarget(picked)
                    setInput((prev) =>
                      prev.trim()
                        ? prev
                        : `把「${picked.text || picked.tag}」这个元素改成：`,
                    )
                    showToast('已选中元素，可描述修改要求')
                  }}
                />
              ) : (
                <div className="grid h-full place-items-center px-6 text-center">
                  <div>
                    <div className="mx-auto h-8 w-8 animate-spin rounded-full border-2 border-neutral-200 border-t-indigo-500" />
                    <p className="mt-4 text-[13px] font-medium text-neutral-700">正在生成第一个版本…</p>
                    <p className="mt-1 text-[11px] text-neutral-400">左侧可以看到规划、生成与验收的完整过程</p>
                  </div>
                </div>
              )}
            </div>

            {tab === 'console' && (
              <div className="mx-auto h-full max-w-full overflow-auto rounded-xl border border-neutral-200 bg-white p-3 font-mono text-[11px]">
                {consoleEntries.length === 0 ? (
                  <div className="p-4 text-center font-sans text-[12px] text-neutral-400">暂无日志</div>
                ) : (
                  consoleEntries.map((e) => (
                    <div key={e.id} className="flex gap-2 border-b border-neutral-100 py-1 last:border-0">
                      <span className="shrink-0 text-neutral-400">{e.at}</span>
                      <span className={e.level === 'error' ? 'text-red-500' : e.level === 'warn' ? 'text-amber-600' : 'text-emerald-600'}>
                        {e.level === 'error' ? 'ERR' : e.level === 'warn' ? 'WARN' : 'INFO'}
                      </span>
                      <span className="min-w-0 break-all text-neutral-600">{e.text}</span>
                    </div>
                  ))
                )}
              </div>
            )}

            {tab === 'code' && (
              <div className="mx-auto flex h-full max-w-full flex-col overflow-hidden rounded-xl border border-neutral-200 bg-white">
                <div className="flex items-center justify-between border-b border-neutral-200 px-3 py-1.5">
                  <span className="text-[10px] text-neutral-400">单文件 HTML · {project.html.length} 字符</span>
                  <div className="flex gap-1.5">
                    <button
                      onClick={() => {
                        navigator.clipboard.writeText(project.html).then(() => showToast('代码已复制')).catch(() => {})
                      }}
                      className="rounded border border-neutral-200 px-2 py-0.5 text-[10px] text-neutral-600 hover:bg-neutral-50"
                    >
                      复制
                    </button>
                    <button
                      onClick={() => downloadHtml(project.html, `${project.title}.html`)}
                      className="rounded border border-neutral-200 px-2 py-0.5 text-[10px] text-neutral-600 hover:bg-neutral-50"
                    >
                      下载
                    </button>
                  </div>
                </div>
                <pre className="scrollbar-thin min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-all p-3 text-[11px] leading-5 text-neutral-700">
                  {project.html || '当前版本暂无代码'}
                </pre>
              </div>
            )}
          </div>
        </main>
      </div>

      {/* 版本抽屉 */}
      {versionsOpen && (
        <div className="fixed inset-0 z-40 flex justify-end bg-neutral-900/30" onClick={() => setVersionsOpen(false)}>
          <div
            className="flex h-full w-full max-w-[380px] flex-col bg-white shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-neutral-200 px-4 py-3">
              <div>
                <h2 className="text-[14px] font-semibold text-neutral-900">版本历史</h2>
                <p className="mt-0.5 text-[10px] text-neutral-400">每个版本都是完整快照，可随时恢复</p>
              </div>
              <button onClick={() => setVersionsOpen(false)} className="text-neutral-400 hover:text-neutral-700">
                ✕
              </button>
            </div>
            <div className="scrollbar-thin flex-1 overflow-y-auto p-3">
              {project.versions.length === 0 && (
                <div className="py-10 text-center text-[12px] text-neutral-400">暂无版本</div>
              )}
              <div className="space-y-2">
                {project.versions.map((v) => {
                  const current = v.id === project.currentVersionId
                  const published = v.id === project.publishedVersionId
                  return (
                    <div key={v.id} className="rounded-xl border border-neutral-200 p-3">
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <span className="text-[13px] font-semibold text-neutral-900">v{v.seq}</span>
                          {current && <span className="rounded bg-indigo-50 px-1.5 py-0.5 text-[9px] font-medium text-indigo-600">当前</span>}
                          {published && <span className="rounded bg-emerald-50 px-1.5 py-0.5 text-[9px] font-medium text-emerald-600">已发布</span>}
                        </div>
                        <div className="flex items-center gap-2">
                          {v.score != null && <ScoreRing score={v.score} size={34} />}
                          <button
                            disabled={current}
                            onClick={() => restore(v.id)}
                            className="rounded-lg border border-neutral-200 px-2 py-1 text-[10px] text-neutral-600 hover:bg-neutral-50 disabled:text-neutral-300"
                          >
                            恢复
                          </button>
                        </div>
                      </div>
                      <div className="mt-1.5 text-[10px] text-neutral-400">
                        {shortModel(v.model)} · {v.source} · {new Date(v.createdAt).toLocaleString('zh-CN', { hour12: false })}
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
            <div className="border-t border-neutral-200 p-3 text-[10px] leading-4 text-neutral-400">
              提示：编辑失败时不会产生新版本，当前版本保持不变。
            </div>
          </div>
        </div>
      )}

      {/* 发布面板 */}
      {publishOpen && (
        <div className="fixed inset-0 z-40 grid place-items-center bg-neutral-900/40 p-4" onClick={() => setPublishOpen(false)}>
          <div className="w-full max-w-md rounded-2xl bg-white p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-start justify-between">
              <div>
                <h2 className="text-[16px] font-semibold text-neutral-900">{sharePath ? '已发布' : '发布应用'}</h2>
                <p className="mt-1 text-[12px] text-neutral-500">
                  发布 = 固定当前版本为公开链接；后续更新可再次发布覆盖。
                </p>
              </div>
              <button onClick={() => setPublishOpen(false)} className="text-neutral-400 hover:text-neutral-700">
                ✕
              </button>
            </div>
            {sharePath ? (
              <>
                <div className="mt-4 flex gap-2">
                  <input
                    readOnly
                    value={shareUrl}
                    className="min-w-0 flex-1 rounded-lg border border-neutral-200 bg-neutral-50 px-3 py-2 text-[12px] text-neutral-700"
                  />
                  <button
                    onClick={copyLink}
                    className="shrink-0 rounded-lg bg-indigo-600 px-3 py-2 text-[12px] font-medium text-white hover:bg-indigo-700"
                  >
                    复制
                  </button>
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    onClick={() => window.open(sharePath, '_blank')}
                    className="rounded-lg border border-neutral-200 px-3 py-1.5 text-[12px] text-neutral-600 hover:bg-neutral-50"
                  >
                    打开链接
                  </button>
                  <button
                    onClick={() => {
                      setPublishOpen(false)
                      navigate(sharePath)
                    }}
                    className="rounded-lg border border-neutral-200 px-3 py-1.5 text-[12px] text-neutral-600 hover:bg-neutral-50"
                  >
                    预览访客视图
                  </button>
                  <button onClick={unpublish} className="rounded-lg border border-red-200 px-3 py-1.5 text-[12px] text-red-600 hover:bg-red-50">
                    下线
                  </button>
                </div>
                <p className="mt-3 text-[11px] leading-5 text-neutral-400">
                  访客数据按浏览器隔离保存，不会与你的编辑数据混用。
                </p>
              </>
            ) : (
              <button
                onClick={publish}
                disabled={!project.currentVersionId}
                className="mt-4 w-full rounded-xl bg-indigo-600 py-2.5 text-[13px] font-semibold text-white hover:bg-indigo-700 disabled:bg-neutral-300"
              >
                发布当前版本 v{project.versions[0]?.seq ?? 1}
              </button>
            )}
          </div>
        </div>
      )}

      {toast && (
        <div className="fixed bottom-5 left-1/2 z-50 -translate-x-1/2 rounded-full bg-neutral-900 px-4 py-2 text-[12px] text-white shadow-lg">
          {toast}
        </div>
      )}
    </div>
  )
}
