import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { api } from '../api'
import { BrandMark } from '../components/Header'

interface Props {
  onDone: () => void
}

const VALUE_POINTS = [
  '一句话拆成需求与验收清单',
  '双路生成，沙箱内真实运行与打分',
  '版本可回退，失败不覆盖当前版本',
  '一键发布成公开链接，数据自动保存',
]

export default function Login({ onDone }: Props) {
  const navigate = useNavigate()
  const [tab, setTab] = useState<'login' | 'register'>('register')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [name, setName] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    setError('')
    try {
      if (tab === 'register') {
        await api('/api/auth/register', { method: 'POST', body: { email, password, name } })
      } else {
        await api('/api/auth/login', { method: 'POST', body: { email, password } })
      }
      onDone()
      navigate('/')
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="min-h-screen bg-paper">
      <div className="mx-auto grid min-h-screen max-w-[1200px] items-center gap-12 px-4 py-8 sm:px-6 lg:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)] lg:py-12">
        {/* 左侧表单 */}
        <section className="mx-auto w-full max-w-[390px]">
          <Link
            to="/"
            className="mb-8 inline-flex items-center gap-1.5 text-[12px] text-ink-muted transition hover:text-ink"
          >
            <span aria-hidden="true">←</span> 返回首页
          </Link>
          <h1 className="text-[30px] leading-[1.2] font-semibold tracking-tight text-ink">
            {tab === 'register' ? '创建你的 Atoms 账号' : '欢迎回来'}
          </h1>
          <p className="mt-2 text-[13px] leading-6 text-ink-muted">
            {tab === 'register'
              ? '注册后，当前游客模式下的项目会保留在账号中，并可跨设备找回。'
              : '登录后可跨设备访问你的项目、版本与发布记录。'}
          </p>

          <div className="mt-7 flex rounded-full bg-canvas p-1">
            {(['register', 'login'] as const).map((t) => (
              <button
                key={t}
                onClick={() => {
                  setTab(t)
                  setError('')
                }}
                className={`flex-1 rounded-full py-2 text-[13px] font-medium transition ${
                  tab === t ? 'bg-white text-ink shadow-[0_1px_2px_rgba(12,12,12,0.08)]' : 'text-ink-muted hover:text-ink'
                }`}
              >
                {t === 'register' ? '注册' : '登录'}
              </button>
            ))}
          </div>

          <form onSubmit={submit} className="mt-6 space-y-4">
            {tab === 'register' && (
              <label className="block">
                <span className="mb-1.5 block text-[12px] font-medium text-ink-muted">昵称（可选）</span>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  maxLength={24}
                  className="field"
                  placeholder="怎么称呼你"
                />
              </label>
            )}
            <label className="block">
              <span className="mb-1.5 block text-[12px] font-medium text-ink-muted">邮箱</span>
              <input
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                type="email"
                required
                autoComplete="email"
                className="field"
                placeholder="you@example.com"
              />
            </label>
            <label className="block">
              <span className="mb-1.5 block text-[12px] font-medium text-ink-muted">密码</span>
              <input
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                type="password"
                required
                minLength={8}
                autoComplete={tab === 'register' ? 'new-password' : 'current-password'}
                className="field"
                placeholder="至少 8 位"
              />
            </label>
            {error && (
              <div className="rounded-lg bg-bad-soft px-3 py-2 text-[12px] text-bad" role="alert">
                {error}
              </div>
            )}
            <button
              type="submit"
              disabled={busy}
              className="btn btn-primary h-11 w-full text-[14px]"
            >
              {busy ? '处理中…' : tab === 'register' ? '注册并继续' : '登录'}
            </button>
          </form>

          <p className="mt-5 text-[12px] leading-5 text-ink-muted">
            不注册也可以继续使用，项目会保存在当前浏览器。
            <Link to="/" className="ml-1 text-brand hover:underline">
              先逛逛
            </Link>
          </p>
          <p className="mt-2 text-[11px] leading-5 text-ink-faint">密码使用 scrypt + 随机盐哈希，仅保存哈希值。</p>
        </section>

        {/* 右侧品牌面板：原创几何构图，不复制官方插图 */}
        <aside className="relative hidden min-h-[620px] overflow-hidden rounded-[24px] bg-brand p-10 text-white lg:flex lg:flex-col">
          <div className="relative z-10 flex items-center gap-2.5">
            <BrandMark size={26} />
            <span className="text-[15px] font-semibold tracking-tight">Atoms Demo</span>
          </div>

          <div className="relative z-10 mt-16 max-w-[360px]">
            <h2 className="text-[34px] leading-[1.25] font-semibold tracking-tight">
              把一句话，变成
              <br />
              可运行的产品
            </h2>
            <ul className="mt-8 space-y-3.5">
              {VALUE_POINTS.map((point) => (
                <li key={point} className="flex items-start gap-2.5 text-[14px] leading-6 text-white/90">
                  <span className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full border border-white/40 text-[10px]">
                    ✓
                  </span>
                  {point}
                </li>
              ))}
            </ul>
          </div>

          <div className="relative z-10 mt-auto flex items-center justify-between text-[11px] text-white/60">
            <span>需求拆解 · 双路生成 · 沙箱验收</span>
            <span>v1.0</span>
          </div>

          <svg
            className="pointer-events-none absolute -right-24 -bottom-28 opacity-30"
            width="520"
            height="520"
            viewBox="0 0 520 520"
            fill="none"
            aria-hidden="true"
          >
            <ellipse cx="260" cy="260" rx="240" ry="96" stroke="white" strokeWidth="1.2" />
            <ellipse cx="260" cy="260" rx="240" ry="96" stroke="white" strokeWidth="1.2" transform="rotate(60 260 260)" />
            <ellipse cx="260" cy="260" rx="240" ry="96" stroke="white" strokeWidth="1.2" transform="rotate(120 260 260)" />
            <circle cx="260" cy="260" r="54" fill="white" fillOpacity="0.12" />
            <circle cx="260" cy="260" r="10" fill="white" />
          </svg>
          <div className="pointer-events-none absolute -left-16 top-24 h-48 w-48 rounded-full border border-white/20" />
        </aside>
      </div>
    </main>
  )
}
