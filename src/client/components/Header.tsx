import { Link } from 'react-router-dom'
import { api } from '../api'
import type { User } from '../types'

interface Props {
  user: User | null
  onLogout: () => void
}

export default function Header({ user, onLogout }: Props) {
  const logout = async () => {
    await api('/api/auth/logout', { method: 'POST' }).catch(() => {})
    location.reload()
  }
  return (
    <header className="sticky top-0 z-30 border-b border-neutral-200/80 bg-white/80 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-4 sm:px-6">
        <Link to="/" className="flex items-center gap-2.5">
          <span className="grid h-8 w-8 place-items-center rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600 text-[15px] font-bold text-white shadow-sm">
            A
          </span>
          <span className="text-[15px] font-semibold tracking-tight text-neutral-900">Atoms Demo</span>
          <span className="hidden rounded-full border border-neutral-200 px-2 py-0.5 text-[11px] text-neutral-500 sm:inline">
            智能体生成应用
          </span>
        </Link>
        <div className="flex items-center gap-2">
          {user ? (
            <>
              {user.kind === 'guest' ? (
                <>
                  <span className="hidden rounded-full bg-amber-50 px-2.5 py-1 text-[12px] font-medium text-amber-700 sm:inline">
                    游客模式
                  </span>
                  <Link
                    to="/login"
                    className="rounded-lg bg-neutral-900 px-3.5 py-1.5 text-[13px] font-medium text-white hover:bg-neutral-800"
                  >
                    登录 / 注册
                  </Link>
                </>
              ) : (
                <>
                  <span className="hidden text-[13px] text-neutral-500 sm:inline">{user.email}</span>
                  <button
                    onClick={logout}
                    className="rounded-lg border border-neutral-200 px-3 py-1.5 text-[13px] text-neutral-600 hover:bg-neutral-50"
                  >
                    退出
                  </button>
                </>
              )}
            </>
          ) : null}
        </div>
      </div>
    </header>
  )
}
