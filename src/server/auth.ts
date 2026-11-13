// 认证：游客优先 + 邮箱账号（scrypt 哈希），会话只存 token 哈希
import type { NextFunction, Request, Response } from 'express'
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import {
  createGuestUser,
  createSession,
  createEmailUser,
  deleteSession,
  findUserByEmail,
  findUserBySessionToken,
  findUserById,
  sha256,
  upgradeGuestToEmail,
} from './store.js'
import type { UserRow } from './db.js'
import { config } from './config.js'

export const SID_COOKIE = 'atoms_sid'
export const VID_COOKIE = 'atoms_vid'

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (!header) return out
  for (const part of header.split(';')) {
    const idx = part.indexOf('=')
    if (idx === -1) continue
    const k = part.slice(0, idx).trim()
    const v = part.slice(idx + 1).trim()
    if (k) out[k] = decodeURIComponent(v)
  }
  return out
}

export function getCookies(req: Request): Record<string, string> {
  return parseCookies(req.headers.cookie)
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex')
  const key = scryptSync(password, salt, 64).toString('hex')
  return `scrypt$${salt}$${key}`
}

export function verifyPassword(password: string, stored: string | null): boolean {
  if (!stored) return false
  const [scheme, salt, hash] = stored.split('$')
  if (scheme !== 'scrypt' || !salt || !hash) return false
  const key = scryptSync(password, salt, 64).toString('hex')
  try {
    return timingSafeEqual(Buffer.from(key, 'hex'), Buffer.from(hash, 'hex'))
  } catch {
    return false
  }
}

/** 是否 HTTPS 请求：直连 TLS 或反代传入 X-Forwarded-Proto=https（trust proxy 已开启） */
export function isSecureRequest(req: Request): boolean {
  if (req.secure) return true
  const proto = (req.get('x-forwarded-proto') || '').split(',')[0]?.trim().toLowerCase()
  return proto === 'https'
}

function setCookie(res: Response, name: string, value: string, maxAgeDays: number, secure: boolean): void {
  res.cookie(name, value, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: maxAgeDays * 24 * 3600 * 1000,
    // HTTP 直连不加 Secure（否则浏览器丢弃 Cookie）；HTTPS 部署自动开启
    secure,
  })
}

/** 为每个请求准备用户：有会话则识别，无则会话透明创建游客 */
export function attachUser(req: Request, res: Response, next: NextFunction): void {
  const cookies = getCookies(req)
  const secure = isSecureRequest(req)

  if (!cookies[VID_COOKIE]) {
    setCookie(res, VID_COOKIE, randomBytes(8).toString('hex'), 30, secure)
  }

  const token = cookies[SID_COOKIE]
  if (token) {
    const user = findUserBySessionToken(token)
    if (user) {
      req.user = user
      req.sessionToken = token
      next()
      return
    }
  }
  const user = createGuestUser()
  const freshToken = createSession(user.id)
  setCookie(res, SID_COOKIE, freshToken, 7, secure)
  req.user = user
  req.sessionToken = freshToken
  next()
}

/** 登录/注册成功后替换会话 */
export function rotateSession(req: Request, res: Response, user: UserRow): void {
  if (req.sessionToken) deleteSession(req.sessionToken)
  const token = createSession(user.id)
  setCookie(res, SID_COOKIE, token, 7, isSecureRequest(req))
  req.sessionToken = token
  req.user = user
}

export function publicUser(user: UserRow) {
  return { id: user.id, kind: user.kind, email: user.email, name: user.name }
}

export function registerEmailUser(email: string, password: string, name: string): { user?: UserRow; error?: string } {
  if (findUserByEmail(email)) return { error: '该邮箱已注册，请直接登录' }
  return { user: createEmailUser(email, hashPassword(password), name) }
}

export function loginWithPassword(email: string, password: string): { user?: UserRow; error?: string } {
  const user = findUserByEmail(email)
  if (!user || !verifyPassword(password, user.password_hash)) return { error: '邮箱或密码不正确' }
  return { user }
}

export function upgradeUser(user: UserRow, email: string, password: string, name: string): { user?: UserRow; error?: string } {
  if (user.kind !== 'guest') return { error: '当前已是账号模式' }
  if (findUserByEmail(email)) return { error: '该邮箱已注册，请直接登录' }
  return { user: upgradeGuestToEmail(user.id, email, hashPassword(password), name) }
}

/** 极简滑动窗口限流：登录防爆破与生成配额共用 */
const buckets = new Map<string, { count: number; resetAt: number }>()

export interface RateLimitResult {
  allowed: boolean
  retryAfterSec: number
  remaining: number
}

export function consumeRateLimit(key: string, limit: number, windowMs: number): RateLimitResult {
  const t = Date.now()
  const b = buckets.get(key)
  if (!b || b.resetAt <= t) {
    buckets.set(key, { count: 1, resetAt: t + windowMs })
    return { allowed: true, retryAfterSec: Math.ceil(windowMs / 1000), remaining: limit - 1 }
  }
  b.count += 1
  return {
    allowed: b.count <= limit,
    retryAfterSec: Math.max(1, Math.ceil((b.resetAt - t) / 1000)),
    remaining: Math.max(0, limit - b.count),
  }
}

export function checkRateLimit(key: string, limit: number, windowMs: number): boolean {
  return consumeRateLimit(key, limit, windowMs).allowed
}

/** 生成配额：每用户每小时 N 次（游客与登录账号按同一 user.id 计数），超限返回 429 */
export function takeGenerationQuota(req: Request, res: Response): boolean {
  const result = consumeRateLimit(`generate:${req.user.id}`, config.generationRateLimit, 3600_000)
  if (result.allowed) return true
  res.setHeader('Retry-After', String(result.retryAfterSec))
  res.status(429).json({
    error: `生成次数已达上限（每用户每小时 ${config.generationRateLimit} 次），请稍后再试`,
  })
  return false
}

export function getUserById(id: string): UserRow | undefined {
  return findUserById(id)
}

export function visitorIdFrom(req: Request): string {
  return getCookies(req)[VID_COOKIE] || ''
}

export const hashToken = sha256
