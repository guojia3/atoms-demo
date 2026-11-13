import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { api } from '../api'

interface Props {
  onDone: () => void
}

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
    <main className="mx-auto flex min-h-[calc(100vh-56px)] max-w-md flex-col justify-center px-4 py-10">
      <div className="rounded-2xl border border-neutral-200 bg-white p-6 shadow-sm sm:p-8">
        <h1 className="text-[22px] font-semibold tracking-tight text-neutral-900">
          {tab === 'register' ? '创建账号' : '欢迎回来'}
        </h1>
        <p className="mt-2 text-[13px] leading-5 text-neutral-500">
          {tab === 'register'
            ? '注册后，当前游客模式下的项目会保留在账号中，并可跨设备找回。'
            : '登录后可跨设备访问你的项目与版本。'}
        </p>

        <div className="mt-5 grid grid-cols-2 gap-1 rounded-xl bg-neutral-100 p-1">
          {(['register', 'login'] as const).map((t) => (
            <button
              key={t}
              onClick={() => {
                setTab(t)
                setError('')
              }}
              className={`rounded-lg py-2 text-[13px] font-medium transition ${
                tab === t ? 'bg-white text-neutral-900 shadow-sm' : 'text-neutral-500 hover:text-neutral-700'
              }`}
            >
              {t === 'register' ? '注册' : '登录'}
            </button>
          ))}
        </div>

        <form onSubmit={submit} className="mt-5 space-y-4">
          {tab === 'register' && (
            <label className="block">
              <span className="mb-1.5 block text-[12px] font-medium text-neutral-600">昵称（可选）</span>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={24}
                className="w-full rounded-xl border border-neutral-200 px-3.5 py-2.5 text-[14px] outline-none transition focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
                placeholder="怎么称呼你"
              />
            </label>
          )}
          <label className="block">
            <span className="mb-1.5 block text-[12px] font-medium text-neutral-600">邮箱</span>
            <input
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              type="email"
              required
              autoComplete="email"
              className="w-full rounded-xl border border-neutral-200 px-3.5 py-2.5 text-[14px] outline-none transition focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
              placeholder="you@example.com"
            />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-[12px] font-medium text-neutral-600">密码</span>
            <input
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              type="password"
              required
              minLength={8}
              autoComplete={tab === 'register' ? 'new-password' : 'current-password'}
              className="w-full rounded-xl border border-neutral-200 px-3.5 py-2.5 text-[14px] outline-none transition focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
              placeholder="至少 8 位"
            />
          </label>
          {error && <div className="rounded-lg bg-red-50 px-3 py-2 text-[12px] text-red-600">{error}</div>}
          <button
            type="submit"
            disabled={busy}
            className="w-full rounded-xl bg-indigo-600 py-2.5 text-[14px] font-semibold text-white transition hover:bg-indigo-700 disabled:bg-neutral-300"
          >
            {busy ? '处理中…' : tab === 'register' ? '注册并继续' : '登录'}
          </button>
        </form>

        <p className="mt-4 text-center text-[12px] text-neutral-400">
          不注册也可以继续使用，项目会保存在当前浏览器。
          <Link to="/" className="ml-1 text-indigo-600 hover:underline">
            返回首页
          </Link>
        </p>
        <p className="mt-2 text-center text-[11px] text-neutral-400">密码使用 scrypt + 随机盐哈希，仅保存哈希值。</p>
      </div>
    </main>
  )
}
