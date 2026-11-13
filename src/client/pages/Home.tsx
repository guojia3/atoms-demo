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

const COVERS: Record<string, { label: string; className: string }> = {
  kanban: { label: '效率', className: 'bg-gradient-to-br from-indigo-500 to-violet-500' },
  habit: { label: '习惯', className: 'bg-gradient-to-br from-emerald-500 to-teal-500' },
  game2048: { label: '游戏', className: 'bg-gradient-to-br from-amber-400 to-orange-500' },
  pomodoro: { label: '专注', className: 'bg-gradient-to-br from-rose-500 to-orange-500' },
  notes: { label: '笔记', className: 'bg-gradient-to-br from-sky-500 to-indigo-500' },
  expense: { label: '记账', className: 'bg-gradient-to-br from-fuchsia-500 to-pink-500' },
}
const FALLBACK_COVERS = [
  'bg-gradient-to-br from-indigo-500 to-violet-500',
  'bg-gradient-to-br from-emerald-500 to-teal-500',
  'bg-gradient-to-br from-amber-400 to-orange-500',
]

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
    <main className="mx-auto max-w-6xl px-4 pb-16 pt-10 sm:px-6 sm:pt-16">
      {user?.kind === 'guest' && (
        <div className="mb-8 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-amber-200 bg-amber-50/70 px-4 py-3 text-[13px] text-amber-800">
          <span>当前为游客模式：项目保存在本设备浏览器中。注册邮箱账号可跨设备找回。</span>
          <Link to="/login" className="font-medium text-amber-900 underline underline-offset-2">
            免费注册 / 登录
          </Link>
        </div>
      )}

      <section className="mx-auto max-w-3xl text-center">
        <div className="mb-5 inline-flex items-center gap-2 rounded-full border border-neutral-200 bg-white px-3 py-1 text-[12px] text-neutral-600 shadow-sm">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
          {config?.mock
            ? '演示模式：未配置模型 Key，内置模板仍可完整体验'
            : `模型已就绪：${config?.model.primary || 'OpenAI 兼容接口'}`}
        </div>
        <h1 className="text-[34px] font-semibold leading-[1.15] tracking-tight text-neutral-900 sm:text-[46px]">
          一句话，生成一个
          <span className="bg-gradient-to-r from-indigo-600 to-violet-600 bg-clip-text text-transparent">能运行的应用</span>
        </h1>
        <p className="mx-auto mt-4 max-w-xl text-[14px] leading-6 text-neutral-500 sm:text-[15px]">
          智能体团队先拆解需求与验收标准，再生成单文件网页应用；沙箱里真实运行、逐条验收、自动保存版本，最后发布成链接。
        </p>
      </section>

      <section className="mx-auto mt-8 max-w-3xl">
        <div className="rounded-2xl border border-neutral-200 bg-white p-2.5 shadow-[0_20px_50px_-24px_rgba(24,24,27,0.25)]">
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit()
            }}
            rows={3}
            maxLength={400}
            placeholder="描述你想做的应用，例如：做一个任务看板，支持添加任务并推进状态，刷新后数据还在"
            className="w-full resize-none rounded-xl bg-transparent px-3 py-2 text-[14px] leading-6 text-neutral-900 outline-none placeholder:text-neutral-400"
          />
          <div className="flex items-center justify-between gap-3 px-2 pb-1 pt-1">
            <span className="text-[11px] text-neutral-400">{prompt.length}/400 · ⌘/Ctrl + Enter 生成</span>
            <button
              onClick={submit}
              disabled={prompt.trim().length < 4 || creating}
              className="rounded-xl bg-indigo-600 px-5 py-2.5 text-[13px] font-semibold text-white shadow-sm transition hover:bg-indigo-700 disabled:cursor-not-allowed disabled:bg-neutral-300"
            >
              {creating ? '正在创建…' : '开始生成 →'}
            </button>
          </div>
        </div>
        {error && <div className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-[12px] text-red-600">{error}</div>}
        <div className="mt-3 flex flex-wrap gap-2">
          {EXAMPLES.map((ex) => (
            <button
              key={ex}
              onClick={() => setPrompt(ex)}
              className="rounded-full border border-neutral-200 bg-white px-3 py-1.5 text-[12px] text-neutral-600 transition hover:border-indigo-300 hover:text-indigo-700"
            >
              {ex.length > 30 ? `${ex.slice(0, 30)}…` : ex}
            </button>
          ))}
        </div>
      </section>

      {samples.length > 0 && (
        <section className="mt-14">
          <div className="mb-4 flex items-end justify-between">
            <div>
              <h2 className="text-[17px] font-semibold text-neutral-900">预置成品</h2>
              <p className="mt-1 text-[12px] text-neutral-500">已发布的应用，点开即可直接使用（含真实持久化）</p>
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {samples.map((s, i) => {
              const cover = COVERS[s.kind || '']
              return (
                <Link
                  key={s.id}
                  to={`/s/${s.slug}`}
                  className="group overflow-hidden rounded-2xl border border-neutral-200 bg-white transition hover:-translate-y-0.5 hover:border-indigo-200 hover:shadow-lg"
                >
                  <div className={`relative h-24 ${cover ? cover.className : FALLBACK_COVERS[i % FALLBACK_COVERS.length]}`}>
                    <span className="absolute left-4 top-3.5 rounded-full bg-white/20 px-2.5 py-1 text-[11px] font-medium text-white backdrop-blur">
                      {cover?.label || '应用'}
                    </span>
                    <span className="absolute bottom-3 left-4 rounded-full bg-white/20 px-2.5 py-1 text-[11px] font-medium text-white backdrop-blur">
                      {s.score ? `${s.score} 分` : '已发布'}
                    </span>
                  </div>
                  <div className="p-4">
                    <h3 className="text-[15px] font-semibold text-neutral-900 group-hover:text-indigo-700">{s.title}</h3>
                    <p className="mt-1 line-clamp-2 text-[12px] leading-5 text-neutral-500">{s.prompt}</p>
                    <span className="mt-3 inline-flex items-center gap-1 text-[12px] font-medium text-indigo-600">
                      打开应用 <span className="transition group-hover:translate-x-0.5">→</span>
                    </span>
                  </div>
                </Link>
              )
            })}
          </div>
        </section>
      )}

      <section className="mt-14">
        <div className="mb-4 flex items-end justify-between">
          <div>
            <h2 className="text-[17px] font-semibold text-neutral-900">我的项目</h2>
            <p className="mt-1 text-[12px] text-neutral-500">
              {projects.length > 0 ? `${projects.length} 个项目 · 每个版本都可回退` : '还没有项目，输入一句话开始'}
            </p>
          </div>
          {projects.length > 0 && (
            <button onClick={load} className="text-[12px] text-neutral-500 hover:text-neutral-900">
              刷新
            </button>
          )}
        </div>
        {projects.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-neutral-300 bg-white/60 px-6 py-10 text-center text-[13px] text-neutral-500">
            生成第一个应用后，这里会显示你的项目与版本记录。
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {projects.map((p) => (
              <Link
                key={p.id}
                to={`/p/${p.id}`}
                className="flex items-start justify-between gap-4 rounded-2xl border border-neutral-200 bg-white p-4 transition hover:border-indigo-200 hover:shadow-sm"
              >
                <div className="min-w-0">
                  <h3 className="truncate text-[14px] font-semibold text-neutral-900">{p.title}</h3>
                  <p className="mt-1 line-clamp-1 text-[12px] text-neutral-500">{p.prompt}</p>
                  <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-neutral-400">
                    <span>{p.versionCount} 个版本</span>
                    <span>·</span>
                    <span>{timeAgo(p.updatedAt)}</span>
                    {p.published && (
                      <span className="rounded-full bg-emerald-50 px-2 py-0.5 font-medium text-emerald-600">已发布</span>
                    )}
                  </div>
                </div>
                <div className="shrink-0 rounded-xl bg-neutral-50 px-2.5 py-1.5 text-center">
                  <div className="text-[16px] font-semibold text-indigo-600">{p.score ?? '—'}</div>
                  <div className="text-[10px] text-neutral-400">版本分</div>
                </div>
              </Link>
            ))}
          </div>
        )}
      </section>

      <footer className="mt-16 border-t border-neutral-200 pt-6 text-center text-[11px] leading-5 text-neutral-400">
        生成物运行在无同源沙箱中 · 数据自动同步到云端 · 无模型时自动降级为内置模板
      </footer>
    </main>
  )
}
