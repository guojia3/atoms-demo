import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import Sandbox from '../components/Sandbox'
import { api, downloadHtml } from '../api'
import type { User } from '../types'

interface ShareData {
  projectId: string
  title: string
  prompt: string
  html: string
  seq: number
  score: number | null
  publishedAt: string
  source: string
  mock: boolean
}

/** 来源标注：模板/回退明确写“内置示例”，避免被误认为模型产出 */
function sourceLabel(data: ShareData): string {
  if (!data.mock) return '模型生成'
  if (data.source === 'fallback') return '模型不可用 · 内置模板'
  if (data.source === 'restore') return '内置示例（回退版本）'
  return '内置示例（模板）'
}

interface Props {
  user: User | null
  onLogout: () => void
}

export default function SharePage({ user }: Props) {
  const { slug = '' } = useParams()
  const [data, setData] = useState<ShareData | null>(null)
  const [kv, setKv] = useState<Record<string, string>>({})
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const res = await api<ShareData>(`/api/share/${slug}`)
        if (cancelled) return
        setData(res)
        const kvRes = await api<{ data: Record<string, string> }>(`/api/share/${slug}/kv`)
        if (!cancelled) setKv(kvRes.data || {})
      } catch (err) {
        if (!cancelled) setError((err as Error).message)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [slug])

  return (
    <div className="flex min-h-screen flex-col bg-neutral-100">
      <header className="flex min-h-14 items-center justify-between gap-3 border-b border-neutral-200 bg-white px-4 py-1.5 sm:px-6">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <Link to="/" className="flex shrink-0 items-center gap-2">
            <span className="grid h-7 w-7 place-items-center rounded-lg bg-gradient-to-br from-indigo-500 to-violet-600 text-[13px] font-bold text-white">
              A
            </span>
            <span className="hidden text-[13px] font-semibold text-neutral-800 sm:inline">Atoms Demo</span>
          </Link>
          <span className="h-4 w-px shrink-0 bg-neutral-200" />
          <div className="min-w-0">
            <div className="truncate text-[14px] font-semibold text-neutral-900">{data?.title || '加载中…'}</div>
            <div className="truncate text-[11px] text-neutral-400">
              {data ? `v${data.seq} · ${data.score ?? '—'} 分 · ${sourceLabel(data)}` : slug}
            </div>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {data && (
            <button
              onClick={() => downloadHtml(data.html, `${data.title || 'atoms-app'}.html`)}
              className="rounded-lg border border-neutral-200 px-3 py-1.5 text-[12px] font-medium text-neutral-600 hover:bg-neutral-50"
            >
              导出 HTML
            </button>
          )}
          <Link
            to="/"
            className="rounded-lg bg-indigo-600 px-3.5 py-1.5 text-[12px] font-semibold text-white hover:bg-indigo-700"
          >
            用 Atoms Demo 做一个
          </Link>
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col px-3 py-4 sm:px-6 sm:py-5">
        {error ? (
          <div className="mx-auto mt-20 max-w-md rounded-2xl border border-neutral-200 bg-white p-8 text-center">
            <h1 className="text-[18px] font-semibold text-neutral-900">链接不可用</h1>
            <p className="mt-2 text-[13px] leading-6 text-neutral-500">{error}。可能已被作者下线。</p>
            <Link to="/" className="mt-5 inline-block rounded-xl bg-indigo-600 px-4 py-2 text-[13px] font-medium text-white">
              返回首页
            </Link>
          </div>
        ) : !data ? (
          <div className="grid flex-1 place-items-center text-[13px] text-neutral-400">正在加载应用…</div>
        ) : (
          <>
            <div className="flex-1 overflow-hidden rounded-2xl border border-neutral-200 bg-white shadow-[0_18px_50px_-30px_rgba(24,24,27,0.35)]">
              <div className="flex items-center gap-2 border-b border-neutral-100 bg-neutral-50/80 px-4 py-2">
                <span className="flex gap-1.5">
                  <i className="h-2.5 w-2.5 rounded-full bg-red-400/70" />
                  <i className="h-2.5 w-2.5 rounded-full bg-amber-400/70" />
                  <i className="h-2.5 w-2.5 rounded-full bg-emerald-400/70" />
                </span>
                <span className="ml-2 truncate rounded-md bg-white px-2.5 py-1 text-[11px] text-neutral-400 ring-1 ring-neutral-200">
                  {sourceLabel(data)} · 数据自动保存
                </span>
              </div>
              <div className="h-[calc(100vh-220px)] min-h-[420px]">
                <Sandbox
                  html={data.html}
                  initData={kv}
                  scope={{ kind: 'share', slug }}
                  onConsole={() => {}}
                />
              </div>
            </div>
            <div className="mt-3 flex flex-wrap items-center justify-between gap-2 px-1 text-[11px] text-neutral-400">
              <span>你的操作会自动保存（按访客独立存储），作者更新版本后会切换到最新发布版。</span>
              <span className="flex items-center gap-2">
                {user?.kind === 'guest' && <Link to="/login" className="text-indigo-600 hover:underline">登录</Link>}
                <span>·</span>
                <Link to="/" className="text-indigo-600 hover:underline">我也要做一个</Link>
              </span>
            </div>
          </>
        )}
      </main>
    </div>
  )
}
