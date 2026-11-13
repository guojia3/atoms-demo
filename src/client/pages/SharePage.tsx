import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import Sandbox from '../components/Sandbox'
import { BrandMark } from '../components/Header'
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

function DownloadIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path d="M10 3v9m0 0 3.2-3.2M10 12 6.8 8.8M4 14.5V16h12v-1.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export default function SharePage({ user }: Props) {
  const { slug = '' } = useParams()
  const [data, setData] = useState<ShareData | null>(null)
  // null 表示 KV 尚未拉取完成：等数据就绪后再挂载沙箱，避免 iframe 先以空存储加载一次
  const [kv, setKv] = useState<Record<string, string> | null>(null)
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
    <div className="flex min-h-screen flex-col bg-canvas">
      <header className="sticky top-0 z-40 border-b border-line bg-white/85 backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-[1200px] items-center justify-between gap-3 px-4 sm:px-6">
          <Link to="/" className="flex min-w-0 items-center gap-2.5 text-ink">
            <BrandMark size={24} />
            <span className="hidden text-[15px] font-semibold tracking-tight sm:inline">Atoms Demo</span>
            <span className="rounded-full border border-line px-2 py-0.5 text-[10px] text-ink-muted">分享</span>
          </Link>
          <div className="flex shrink-0 items-center gap-2">
            {data && (
              <button
                onClick={() => downloadHtml(data.html, `${data.title || 'atoms-app'}.html`)}
                className="btn btn-ghost btn-pill btn-sm"
                title="导出单文件 HTML"
              >
                <DownloadIcon />
                <span className="hidden sm:inline">导出 HTML</span>
              </button>
            )}
            <Link to="/" className="btn btn-primary btn-pill btn-sm">
              用 Atoms Demo 做一个
            </Link>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-[1200px] flex-1 px-3 pb-10 pt-6 sm:px-6 sm:pt-8">
        {error ? (
          <div className="mx-auto mt-20 max-w-md rounded-2xl border border-line bg-white p-8 text-center">
            <div className="mx-auto mb-4 grid h-10 w-10 place-items-center rounded-full bg-canvas text-[16px] text-ink-muted">!</div>
            <h1 className="text-[18px] font-semibold text-ink">链接不可用</h1>
            <p className="mt-2 text-[13px] leading-6 text-ink-muted">{error}。可能已被作者下线。</p>
            <Link to="/" className="btn btn-primary mt-5">
              返回首页
            </Link>
          </div>
        ) : !data || kv === null ? (
          <div className="grid flex-1 place-items-center py-24">
            <div className="w-full max-w-[720px]">
              <div className="skeleton mx-auto h-7 w-52" />
              <div className="skeleton mx-auto mt-3 h-4 w-72" />
              <div className="skeleton mt-8 h-[320px] w-full rounded-2xl" />
              <p className="mt-4 text-center text-[12px] text-ink-muted">正在加载应用…</p>
            </div>
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-1.5 text-[12px] text-ink-muted">
              <Link to="/" className="transition hover:text-ink">
                首页
              </Link>
              <span className="text-ink-faint">/</span>
              <span>分享</span>
              <span className="text-ink-faint">/</span>
              <span className="max-w-[220px] truncate text-ink">{data.title}</span>
            </div>

            <div className="mt-4 flex flex-wrap items-start justify-between gap-4">
              <div className="min-w-0">
                <h1 className="text-[26px] leading-[1.25] font-semibold tracking-tight text-ink sm:text-[32px]">
                  {data.title || '未命名应用'}
                </h1>
                <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-ink-muted">
                  <span>v{data.seq}</span>
                  <span className="text-ink-faint">·</span>
                  <span>{data.score ?? '—'} 分</span>
                  <span className="text-ink-faint">·</span>
                  <span className="rounded-full bg-brand-soft px-2 py-0.5 text-[11px] font-medium text-brand">
                    {sourceLabel(data)}
                  </span>
                  <span className="hidden sm:inline">· 数据自动保存</span>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => downloadHtml(data.html, `${data.title || 'atoms-app'}.html`)}
                  className="grid h-9 w-9 place-items-center rounded-full border border-line-strong bg-white text-ink-muted transition hover:text-ink"
                  title="导出 HTML"
                >
                  <DownloadIcon />
                </button>
                <Link
                  to="/"
                  className="grid h-9 w-9 place-items-center rounded-full border border-line-strong bg-white text-ink-muted transition hover:text-ink"
                  title="返回首页"
                >
                  <span aria-hidden="true">↗</span>
                </Link>
                <Link to="/" className="btn btn-primary btn-pill h-9">
                  做一个同款
                </Link>
              </div>
            </div>

            <div className="mt-6 overflow-hidden rounded-2xl border border-line bg-white">
              <div className="flex flex-wrap items-center gap-2 border-b border-line bg-white px-4 py-2.5">
                <span className="flex gap-1.5" aria-hidden="true">
                  <i className="h-2.5 w-2.5 rounded-full bg-black/10" />
                  <i className="h-2.5 w-2.5 rounded-full bg-black/10" />
                  <i className="h-2.5 w-2.5 rounded-full bg-black/10" />
                </span>
                <span className="ml-1 max-w-full truncate rounded-md bg-canvas px-2.5 py-1 text-[11px] text-ink-muted">
                  {sourceLabel(data)} · 数据自动保存
                </span>
              </div>
              {/* 分享页按内容自适应高度：窄屏下棋盘等长内容不被固定容器裁切 */}
              <Sandbox
                html={data.html}
                initData={kv}
                scope={{ kind: 'share', slug }}
                onConsole={() => {}}
                autoHeight
              />
            </div>

            <div className="mt-4 flex flex-wrap items-center justify-between gap-2 px-1 text-[11px] text-ink-muted">
              <span>你的操作会自动保存（按访客独立存储），作者更新版本后会切换到最新发布版。</span>
              <span className="flex items-center gap-2">
                {user?.kind === 'guest' && (
                  <Link to="/login" className="text-brand hover:underline">
                    登录
                  </Link>
                )}
                <span className="text-ink-faint">·</span>
                <Link to="/" className="text-brand hover:underline">
                  我也要做一个
                </Link>
              </span>
            </div>
          </>
        )}
      </main>
    </div>
  )
}
