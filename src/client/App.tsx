import { useEffect, useState } from 'react'
import { Route, Routes, useLocation } from 'react-router-dom'
import { api } from './api'
import Header from './components/Header'
import Home from './pages/Home'
import Workspace from './pages/Workspace'
import SharePage from './pages/SharePage'
import Login from './pages/Login'
import type { ServerConfig, User } from './types'

export default function App() {
  const [user, setUser] = useState<User | null>(null)
  const [config, setConfig] = useState<ServerConfig | null>(null)
  const location = useLocation()

  const refreshUser = async () => {
    try {
      const res = await api<{ user: User }>('/api/me')
      setUser(res.user)
    } catch {
      /* noop */
    }
  }

  useEffect(() => {
    refreshUser()
    api<ServerConfig>('/api/config').then(setConfig).catch(() => {})
  }, [])

  // 页面切换时刷新账号状态（登录/退出后保持一致）
  useEffect(() => {
    refreshUser()
  }, [location.pathname])

  const common = { user, onLogout: () => setUser(null) }

  return (
    <Routes>
      <Route path="/" element={<><Header {...common} /><Home user={user} config={config} /></>} />
      <Route path="/p/:id" element={<Workspace user={user} />} />
      <Route path="/s/:slug" element={<SharePage user={user} onLogout={common.onLogout} />} />
      <Route path="/login" element={<Login onDone={refreshUser} />} />
      <Route path="*" element={<><Header {...common} /><Home user={user} config={config} /></>} />
    </Routes>
  )
}
