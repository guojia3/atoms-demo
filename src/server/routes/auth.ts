// 账号相关接口：游客透明可用，邮箱账号用于跨设备找回
import { Router } from 'express'
import { checkRateLimit, loginWithPassword, publicUser, registerEmailUser, rotateSession, upgradeUser } from '../auth.js'
import { deleteSession, findUserByEmail } from '../store.js'

const router = Router()

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function validatePassword(password: unknown): string | null {
  if (typeof password !== 'string' || password.length < 8) return '密码至少 8 位'
  if (password.length > 72) return '密码过长'
  return null
}

router.get('/me', (req, res) => {
  res.json({ user: publicUser(req.user), guest: req.user.kind === 'guest' })
})

router.post('/auth/register', (req, res) => {
  const ip = req.ip || 'unknown'
  if (!checkRateLimit(`register:${ip}`, 20, 10 * 60 * 1000)) {
    res.status(429).json({ error: '操作过于频繁，请稍后再试' })
    return
  }
  const { email, password, name } = req.body || {}
  if (typeof email !== 'string' || !EMAIL_RE.test(email.trim())) {
    res.status(400).json({ error: '请输入有效邮箱' })
    return
  }
  const pwdError = validatePassword(password)
  if (pwdError) {
    res.status(400).json({ error: pwdError })
    return
  }
  const cleanEmail = email.trim().toLowerCase()
  const displayName = typeof name === 'string' && name.trim() ? name.trim().slice(0, 24) : cleanEmail.split('@')[0]

  if (req.user.kind === 'guest') {
    const result = upgradeUser(req.user, cleanEmail, password, displayName)
    if (result.error) {
      res.status(409).json({ error: result.error })
      return
    }
    rotateSession(req, res, result.user!)
    res.json({ user: publicUser(result.user!), upgraded: true })
    return
  }

  if (findUserByEmail(cleanEmail)) {
    res.status(409).json({ error: '该邮箱已注册，请直接登录' })
    return
  }
  const result = registerEmailUser(cleanEmail, password, displayName)
  if (result.error) {
    res.status(409).json({ error: result.error })
    return
  }
  rotateSession(req, res, result.user!)
  res.json({ user: publicUser(result.user!), upgraded: false })
})

router.post('/auth/login', (req, res) => {
  const ip = req.ip || 'unknown'
  if (!checkRateLimit(`login:${ip}`, 20, 10 * 60 * 1000)) {
    res.status(429).json({ error: '尝试次数过多，请 10 分钟后再试' })
    return
  }
  const { email, password } = req.body || {}
  if (typeof email !== 'string' || typeof password !== 'string') {
    res.status(400).json({ error: '请输入邮箱和密码' })
    return
  }
  const result = loginWithPassword(email.trim().toLowerCase(), password)
  if (result.error) {
    res.status(401).json({ error: result.error })
    return
  }
  rotateSession(req, res, result.user!)
  res.json({ user: publicUser(result.user!) })
})

router.post('/auth/logout', (req, res) => {
  if (req.sessionToken) deleteSession(req.sessionToken)
  res.clearCookie('atoms_sid', { path: '/' })
  res.json({ ok: true })
})

export default router
