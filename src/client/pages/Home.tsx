import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { api, timeAgo } from '../api'
import type { ProjectSummary, SampleSummary, ServerConfig, User } from '../types'

const EXAMPLES = [
  '做一个 2048 游戏，方向键和手机滑动都能玩，最高分保存',
  '做一个番茄钟，25 分钟专注 + 5 分钟休息，完成次数按天保存',
  '做一个 Markdown 笔记应用，支持新建、搜索与实时预览',
  '做一个记账本，记录金额和分类，自动汇总合计',
  '做一个习惯打卡应用，可以按天打卡并显示连续天数',
]

interface CoverStyle {
  label: string
  tint: string
  ink: string
}

const COVERS: Record<string, CoverStyle> = {
  kanban: { label: '效率', tint: '#eef1ff', ink: '#4267ff' },
  habit: { label: '习惯', tint: '#eaf7f1', ink: '#0f9f6e' },
  game2048: { label: '游戏', tint: '#fdf3e7', ink: '#b45309' },
  pomodoro: { label: '专注', tint: '#fdeef0', ink: '#be123c' },
  notes: { label: '笔记', tint: '#eaf4fb', ink: '#0369a1' },
  expense: { label: '记账', tint: '#f5effb', ink: '#7e22ce' },
}
const FALLBACK_COVERS: CoverStyle[] = [
  { label: '应用', tint: '#eef1ff', ink: '#4267ff' },
  { label: '应用', tint: '#eaf7f1', ink: '#0f9f6e' },
  { label: '应用', tint: '#fdf3e7', ink: '#b45309' },
]

function CoverArt({ kind, index }: { kind?: string; index: number }) {
  const cover = COVERS[kind || ''] || FALLBACK_COVERS[index % FALLBACK_COVERS.length]
  return (
    <div
      className="relative h-[150px] overflow-hidden border-b border-line px-5 pt-5"
      style={{ background: cover.tint }}
      aria-hidden="true"
    >
      <div className="mx-auto h-full w-[86%] overflow-hidden rounded-t-[10px] border border-b-0 border-line bg-white shadow-[0_1px_0_rgba(12,12,12,0.02)]">
        <div className="flex items-center gap-1 border-b border-line px-2.5 py-2">
          <i className="h-1.5 w-1.5 rounded-full bg-black/10" />
          <i className="h-1.5 w-1.5 rounded-full bg-black/10" />
          <i className="h-1.5 w-1.5 rounded-full bg-black/10" />
          <span className="ml-2 h-1.5 w-16 rounded-full bg-black/5" />
        </div>
        <div className="p-2.5">
          {kind === 'kanban' && (
            <div className="grid grid-cols-3 gap-1.5">
              {[2, 1, 2].map((n, col) => (
                <div key={col} className="space-y-1.5 rounded-[4px] p-1" style={{ background: cover.tint + '99' }}>
                  <div className="h-1 w-8 rounded-full" style={{ background: cover.ink, opacity: 0.35 }} />
                  {Array.from({ length: n }).map((_, i) => (
                    <div key={i} className="h-5 rounded-[3px] border border-line bg-white" />
                  ))}
                </div>
              ))}
            </div>
          )}
          {kind === 'habit' && (
            <div className="space-y-2">
              <div className="flex gap-1">
                {Array.from({ length: 7 }).map((_, i) => (
                  <span
                    key={i}
                    className="grid h-5 flex-1 place-items-center rounded-[3px] text-[7px]"
                    style={{
                      background: i < 5 ? cover.ink : cover.tint,
                      color: i < 5 ? '#fff' : cover.ink,
                      opacity: i < 5 ? 0.9 : 1,
                    }}
                  >
                    ✓
                  </span>
                ))}
              </div>
              {[0, 1, 2].map((i) => (
                <div key={i} className="flex items-center gap-1.5">
                  <span className="h-1.5 flex-1 rounded-full bg-black/10" />
                  <span className="h-1.5 w-4 rounded-full" style={{ background: cover.ink, opacity: 0.5 }} />
                </div>
              ))}
            </div>
          )}
          {kind === 'game2048' && (
            <div className="mx-auto grid w-[86%] grid-cols-4 gap-1 rounded-[5px] p-1" style={{ background: cover.tint }}>
              {Array.from({ length: 16 }).map((_, i) => (
                <span
                  key={i}
                  className="grid aspect-square place-items-center rounded-[3px] text-[6px] font-semibold"
                  style={{
                    background: [0, 5, 9].includes(i) ? cover.ink : '#fff',
                    color: [0, 5, 9].includes(i) ? '#fff' : cover.ink,
                    opacity: [0, 5, 9].includes(i) ? 0.85 : 0.35,
                  }}
                >
                  {i === 0 ? '2' : i === 5 ? '4' : i === 9 ? '8' : ''}
                </span>
              ))}
            </div>
          )}
          {kind === 'pomodoro' && (
            <div className="flex items-center justify-center gap-4 py-1">
              <div
                className="grid h-[62px] w-[62px] place-items-center rounded-full border-[5px] text-[11px] font-semibold"
                style={{ borderColor: cover.ink, borderRightColor: 'rgba(12,12,12,0.08)', color: cover.ink }}
              >
                25:00
              </div>
              <div className="space-y-1.5">
                <span className="block h-1.5 w-14 rounded-full" style={{ background: cover.ink, opacity: 0.55 }} />
                <span className="block h-1.5 w-10 rounded-full bg-black/10" />
                <span className="block h-4 w-12 rounded-full" style={{ background: cover.tint }} />
              </div>
            </div>
          )}
          {kind === 'notes' && (
            <div className="grid grid-cols-[1.1fr_1fr] gap-1.5">
              <div className="space-y-1.5 rounded-[4px] border border-line p-1.5">
                <span className="block h-1 w-10 rounded-full" style={{ background: cover.ink, opacity: 0.5 }} />
                {[12, 9, 11, 7].map((w, i) => (
                  <span key={i} className="block h-1 rounded-full bg-black/10" style={{ width: `${w * 6}%` }} />
                ))}
              </div>
              <div className="space-y-1.5 rounded-[4px] p-1.5" style={{ background: cover.tint }}>
                <span className="block h-1.5 w-12 rounded-full" style={{ background: cover.ink, opacity: 0.55 }} />
                <span className="block h-1 w-full rounded-full bg-white" />
                <span className="block h-1 w-3/4 rounded-full bg-white" />
                <span className="block h-3 w-8 rounded-[3px]" style={{ background: cover.ink, opacity: 0.2 }} />
              </div>
            </div>
          )}
          {kind === 'expense' && (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="h-1.5 w-10 rounded-full bg-black/10" />
                <span className="rounded-full px-2 py-0.5 text-[7px] font-semibold" style={{ background: cover.tint, color: cover.ink }}>
                  ¥ 128.00
                </span>
              </div>
              {[0, 1, 2].map((i) => (
                <div key={i} className="flex items-center justify-between rounded-[3px] border border-line px-1.5 py-1">
                  <span className="h-1 w-12 rounded-full bg-black/10" />
                  <span className="h-1 w-6 rounded-full" style={{ background: cover.ink, opacity: 0.4 }} />
                </div>
              ))}
            </div>
          )}
          {!COVERS[kind || ''] && (
            <div className="grid grid-cols-3 gap-1.5">
              {[0, 1, 2].map((i) => (
                <div key={i} className="h-12 rounded-[4px] border border-line" />
              ))}
            </div>
          )}
        </div>
      </div>
      <span
        className="absolute left-4 top-3 rounded-full bg-white/90 px-2.5 py-1 text-[10px] font-medium backdrop-blur"
        style={{ color: cover.ink }}
      >
        {cover.label}
      </span>
    </div>
  )
}

interface Props {
  user: User | null
  config: ServerConfig | null
}

export default function Home({ user, config }: Props) {
  const navigate = useNavigate()
  const [prompt, setPrompt] = useState('')
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState('')
  const [projects, setProjects] = useState<ProjectSummary[]>([])
  const [samples, setSamples] = useState<SampleSummary[]>([])

  const load = async () => {
    try {
      const [p, s] = await Promise.all([
        api<{ projects: ProjectSummary[] }>('/api/projects'),
        api<{ samples: SampleSummary[] }>('/api/samples'),
      ])
      setProjects(p.projects)
      setSamples(s.samples)
    } catch {
      /* noop */
    }
  }

  useEffect(() => {
    load()
  }, [])

  // 支持 /#samples、/#projects 直接进入或同页锚点跳转；等数据加载、section 出现后再滚动
  useEffect(() => {
    const scrollToHash = () => {
      const id = window.location.hash.replace(/^#/, '')
      if (!id) return
      const el = document.getElementById(id)
      if (el) el.scrollIntoView({ block: 'start' })
    }
    const timer = setTimeout(scrollToHash, 0)
    window.addEventListener('hashchange', scrollToHash)
    return () => {
      clearTimeout(timer)
      window.removeEventListener('hashchange', scrollToHash)
    }
  }, [samples.length, projects.length])

  const submit = async () => {
    const value = prompt.trim()
    if (value.length < 4 || creating) return
    setCreating(true)
    setError('')
    try {
      const res = await api<{ projectId: string; runId: string }>('/api/projects', {
        method: 'POST',
        body: { prompt: value },
      })
      navigate(`/p/${res.projectId}`)
    } catch (err) {
      setError((err as Error).message)
      setCreating(false)
    }
  }

  return (
    <main className="pb-20">
      {user?.kind === 'guest' && (
        <div className="mx-auto max-w-[1200px] px-4 pt-5 sm:px-6">
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-white px-4 py-3 text-[12px] text-ink-muted">
            <span className="flex items-center gap-2">
              <span className="h-1.5 w-1.5 rounded-full bg-warn" />
              当前为游客模式：项目保存在本设备浏览器中，注册邮箱账号可跨设备找回。
            </span>
            <Link to="/login" className="text-[12px] font-medium text-brand hover:underline">
              免费注册 / 登录
            </Link>
          </div>
        </div>
      )}

      {/* Hero + Composer */}
      <section className="px-4 pt-16 pb-12 sm:px-6 sm:pt-24">
        <div className="mx-auto max-w-[820px] text-center">
          <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-line bg-white px-3 py-1.5 text-[11px] text-ink-muted">
            <span className={`h-1.5 w-1.5 rounded-full ${config?.mock ? 'bg-warn' : 'bg-ok'}`} />
            {config?.mock
              ? '演示模式：未配置模型 Key，内置模板仍可完整体验'
              : `模型已就绪：${config?.model.primary || 'OpenAI 兼容接口'}`}
          </div>

          <h1 className="text-[38px] leading-[1.16] font-semibold tracking-[-0.02em] text-ink sm:text-[52px]">
            一句话，生成一个
            <span className="sm:hidden">
              <br />
            </span>{' '}
            能运行的应用
          </h1>
          <p className="mx-auto mt-5 max-w-[560px] text-[14px] leading-6 text-ink-muted sm:text-[16px] sm:leading-7">
            智能体团队先拆解需求与验收标准，再生成单文件网页应用；沙箱里真实运行、逐条验收、自动保存版本，最后发布成链接。
          </p>

          <div className="mx-auto mt-10 max-w-[760px] text-left">
            <div className="rounded-[24px] border border-line-strong bg-white p-4 transition focus-within:border-brand-line focus-within:shadow-[0_0_0_4px_rgba(66,103,255,0.08)]">
              <textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit()
                }}
                rows={3}
                maxLength={400}
                placeholder="描述你想做的应用，例如：做一个任务看板，支持添加任务并推进状态，刷新后数据还在"
                className="w-full resize-none bg-transparent px-1 py-1 text-[15px] leading-7 text-ink outline-none placeholder:text-ink-faint sm:text-[16px]"
              />
              <div className="mt-2 flex items-center justify-between gap-3">
                <span className="truncate text-[11px] text-ink-faint">
                  {prompt.length}/400 · ⌘/Ctrl + Enter 生成
                </span>
                <button
                  onClick={submit}
                  disabled={prompt.trim().length < 4 || creating}
                  className="btn btn-primary btn-pill h-10 px-5 text-[13px]"
                >
                  {creating ? '正在创建…' : '开始生成 →'}
                </button>
              </div>
            </div>
            {error && (
              <div className="mt-2 rounded-lg bg-bad-soft px-3 py-2 text-[12px] text-bad" role="alert">
                {error}
              </div>
            )}
            <div className="mt-4 flex flex-wrap justify-center gap-2">
              {EXAMPLES.map((ex) => (
                <button
                  key={ex}
                  onClick={() => setPrompt(ex)}
                  className="pill max-w-full transition hover:border-line-strong hover:text-ink"
                  title={ex}
                >
                  <span className="truncate">{ex.length > 26 ? `${ex.slice(0, 26)}…` : ex}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      </section>

      {samples.length > 0 && (
        <section id="samples" className="mx-auto max-w-[1200px] scroll-mt-24 px-4 pt-8 sm:px-6">
          <div className="mb-5 flex items-end justify-between gap-4">
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-[22px] font-medium tracking-tight text-ink">预置成品</h2>
                <span className="pill pill-brand h-6 px-2 text-[10px]">{samples.length} 个</span>
              </div>
              <p className="mt-1.5 text-[13px] text-ink-muted">已发布的应用，点开即可直接使用（含真实持久化）</p>
            </div>
            <a href="#projects" className="text-[12px] text-ink-muted transition hover:text-ink">
              查看我的项目 →
            </a>
          </div>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {samples.map((s, i) => {
              const cover = COVERS[s.kind || ''] || FALLBACK_COVERS[i % FALLBACK_COVERS.length]
              return (
                <Link
                  key={s.id}
                  to={`/s/${s.slug}`}
                  className="group overflow-hidden rounded-2xl border border-line bg-white transition duration-200 hover:-translate-y-0.5 hover:border-line-strong hover:shadow-[0_12px_32px_-24px_rgba(12,12,12,0.35)]"
                >
                  <CoverArt kind={s.kind} index={i} />
                  <div className="p-4">
                    <div className="flex items-start justify-between gap-3">
                      <h3 className="min-w-0 truncate text-[15px] font-semibold text-ink">{s.title}</h3>
                      <span className="shrink-0 rounded-full bg-canvas px-2 py-0.5 text-[10px] text-ink-muted">
                        {s.score ? `${s.score} 分` : '已发布'}
                      </span>
                    </div>
                    <p className="mt-1.5 line-clamp-2 min-h-[40px] text-[12px] leading-5 text-ink-muted">{s.prompt}</p>
                    <span
                      className="mt-3 inline-flex items-center gap-1 text-[12px] font-medium transition group-hover:gap-1.5"
                      style={{ color: cover.ink }}
                    >
                      打开应用 <span aria-hidden="true">→</span>
                    </span>
                  </div>
                </Link>
              )
            })}
          </div>
        </section>
      )}

      <section id="projects" className="mx-auto mt-16 max-w-[1200px] scroll-mt-24 px-4 sm:px-6">
        <div className="mb-5 flex items-end justify-between gap-4">
          <div>
            <h2 className="text-[22px] font-medium tracking-tight text-ink">我的项目</h2>
            <p className="mt-1.5 text-[13px] text-ink-muted">
              {projects.length > 0 ? `${projects.length} 个项目 · 每个版本都可回退` : '还没有项目，输入一句话开始'}
            </p>
          </div>
          {projects.length > 0 && (
            <button onClick={load} className="btn btn-quiet btn-sm">
              刷新
            </button>
          )}
        </div>

        {projects.length === 0 ? (
          <div className="rounded-2xl border border-line bg-white px-6 py-14 text-center">
            <div className="mx-auto flex w-40 flex-col items-center gap-2" aria-hidden="true">
              <span className="skeleton h-3 w-24" />
              <span className="skeleton h-3 w-36" />
              <span className="skeleton h-3 w-20" />
            </div>
            <p className="mt-5 text-[13px] text-ink-muted">生成第一个应用后，这里会显示你的项目与版本记录。</p>
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {projects.map((p) => (
              <Link
                key={p.id}
                to={`/p/${p.id}`}
                className="group flex items-start justify-between gap-4 rounded-2xl border border-line bg-white p-4 transition hover:border-line-strong hover:shadow-[0_10px_28px_-24px_rgba(12,12,12,0.3)]"
              >
                <div className="min-w-0">
                  <h3 className="truncate text-[14px] font-semibold text-ink">{p.title}</h3>
                  <p className="mt-1 line-clamp-1 text-[12px] text-ink-muted">{p.prompt}</p>
                  <div className="mt-2.5 flex flex-wrap items-center gap-2 text-[11px] text-ink-muted">
                    <span>{p.versionCount} 个版本</span>
                    <span className="text-ink-faint">·</span>
                    <span>{timeAgo(p.updatedAt)}</span>
                    {p.published && (
                      <span className="rounded-full bg-ok-soft px-2 py-0.5 font-medium text-ok">已发布</span>
                    )}
                  </div>
                </div>
                <div className="shrink-0 rounded-xl border border-line bg-canvas-soft px-2.5 py-1.5 text-center">
                  <div className="font-mono-ui text-[15px] font-semibold text-brand">{p.score ?? '—'}</div>
                  <div className="text-[9px] text-ink-muted">版本分</div>
                </div>
              </Link>
            ))}
          </div>
        )}
      </section>

      <footer className="mx-auto mt-20 max-w-[1200px] border-t border-line px-4 pt-6 text-center text-[11px] leading-5 text-ink-faint sm:px-6">
        生成物运行在无同源沙箱中 · 数据自动同步到云端 · 无模型时自动降级为内置模板
      </footer>
    </main>
  )
}
