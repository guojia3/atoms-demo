import { Link } from 'react-router-dom'
import { api } from '../api'
import type { User } from '../types'

interface Props {
  user: User | null
  onLogout: () => void
}

/** 原创原子标记：四条轨道 + 中心点，不使用官方 logo */
export function BrandMark({ size = 26, className = '' }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      aria-hidden="true"
      className={className}
    >
      <ellipse cx="16" cy="16" rx="13" ry="5.4" stroke="currentColor" strokeWidth="1.6" />
      <ellipse
        cx="16"
        cy="16"
        rx="13"
        ry="5.4"
        stroke="currentColor"
        strokeWidth="1.6"
        transform="rotate(60 16 16)"
      />
      <ellipse
        cx="16"
        cy="16"
        rx="13"
        ry="5.4"
        stroke="currentColor"
        strokeWidth="1.6"
        transform="rotate(120 16 16)"
      />
      <circle cx="16" cy="16" r="2.6" fill="currentColor" />
    </svg>
  )
}

export default function Header({ user, onLogout }: Props) {
  const logout = async () => {
    await api('/api/auth/logout', { method: 'POST' }).catch(() => {})
    onLogout()
    location.reload()
  }

  return (
    <header className="sticky top-0 z-40 border-b border-line bg-white/85 backdrop-blur-xl">
      <div className="mx-auto flex h-16 max-w-[1200px] items-center justify-between gap-4 px-4 sm:px-6">
        <div className="flex min-w-0 items-center gap-6">
          <Link to="/" className="flex shrink-0 items-center gap-2.5 text-ink">
            <BrandMark size={24} />
            <span className="text-[15px] font-semibold tracking-tight">Atoms Demo</span>
          </Link>
          <nav className="hidden items-center gap-1 md:flex" aria-label="主导航">
            <a className="chip-tab" data-active="true" href="/">
              首页
            </a>
            <a className="chip-tab" href="/#samples">
              预置成品
            </a>
            <a className="chip-tab" href="/#projects">
              我的项目
            </a>
          </nav>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <span className="hidden rounded-full border border-line bg-white px-2.5 py-1 text-[11px] text-ink-muted lg:inline">
            {user?.kind === 'guest' ? '游客模式' : '智能体生成应用'}
          </span>
          {user ? (
            user.kind === 'guest' ? (
              <Link to="/login" className="btn btn-primary btn-pill btn-sm">
                登录 / 注册
              </Link>
            ) : (
              <>
                <span className="hidden max-w-[180px] truncate text-[12px] text-ink-muted sm:inline">
                  {user.email}
                </span>
                <button onClick={logout} className="btn btn-ghost btn-pill btn-sm">
                  退出
                </button>
              </>
            )
          ) : null}
        </div>
      </div>
    </header>
  )
}
