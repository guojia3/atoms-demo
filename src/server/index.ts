// 单进程入口：API + 静态前端 + 启动恢复 + 种子数据
import express from 'express'
import type { NextFunction, Request, Response } from 'express'
import fs from 'node:fs'
import path from 'node:path'
import { config, isMockMode } from './config.js'
import { attachUser } from './auth.js'
import { markInterruptedRuns } from './store.js'
import { seedSamples } from './seed.js'
import authRoutes from './routes/auth.js'
import projectRoutes from './routes/projects.js'
import runRoutes from './routes/runs.js'
import shareRoutes from './routes/share.js'

const app = express()
app.set('trust proxy', 1)
app.disable('x-powered-by')

// 页面级 CSP：不设置 default-src/frame-src，避免 srcdoc 沙箱预览被子策略拦截；
// 脚本允许 inline/eval 以满足 React 运行时与生成应用的执行环境，同时阻断外部脚本。
const PAGE_CSP = [
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "media-src 'self' data: blob:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ')

app.use((_req: Request, res: Response, next: NextFunction) => {
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('X-Frame-Options', 'DENY')
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin')
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()')
  res.setHeader('Content-Security-Policy', PAGE_CSP)
  next()
})

// 请求体上限：默认 1mb；超出由下方错误处理映射为 413
app.use(express.json({ limit: config.bodyLimit }))

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

function normalizeOrigin(value: string): string | null {
  try {
    const url = new URL(value)
    return `${url.protocol}//${url.host}`
  } catch {
    return null
  }
}

/** 状态变更请求的 Origin/Referer 校验；无来源头（curl、smoke、服务端调用）直接放行 */
function isAllowedOrigin(req: Request, raw: string): boolean {
  if (raw === 'null') return false
  const origin = normalizeOrigin(raw)
  if (!origin) return false
  const self = `${req.protocol}://${req.get('host') || ''}`
  if (origin === self) return true
  if (config.publicOrigins.some((item) => normalizeOrigin(item) === origin)) return true
  // 开发模式下 Vite 等本地端口互访
  if (!config.isProd) {
    try {
      const host = new URL(origin).hostname
      if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return true
    } catch {
      return false
    }
  }
  return false
}

app.use((req: Request, res: Response, next: NextFunction) => {
  if (!req.path.startsWith('/api') || !MUTATING_METHODS.has(req.method)) return next()
  const source = req.get('origin') || req.get('referer')
  if (!source) return next()
  if (isAllowedOrigin(req, source)) return next()
  res.status(403).json({ error: '跨站请求被拒绝' })
})

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    db: 'ok',
    mock: isMockMode(),
    model: {
      configured: config.providers.length > 0,
      providers: config.providers.map((p) => ({ name: p.name, model: p.model })),
    },
    probeTimeoutSec: Math.round(config.probeTimeoutMs / 1000),
    commit: config.gitCommit,
    time: new Date().toISOString(),
  })
})

app.get('/api/config', (_req, res) => {
  res.json({
    mock: isMockMode(),
    model: {
      configured: config.providers.length > 0,
      primary: config.providers[0]?.model || null,
      providers: config.providers.map((p) => ({ name: p.name, model: p.model })),
    },
    probeTimeoutSec: Math.round(config.probeTimeoutMs / 1000),
  })
})

// 发布页不需要账号，先挂载，避免为访客创建无用账号
app.use('/api', shareRoutes)

app.use('/api', attachUser, authRoutes, projectRoutes, runRoutes)

app.use('/api', (_req, res) => {
  res.status(404).json({ error: '接口不存在' })
})

if (config.isProd) {
  const indexFile = path.join(config.distDir, 'index.html')
  if (fs.existsSync(indexFile)) {
    app.use(express.static(config.distDir, { maxAge: '1h', index: false }))
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api')) return next()
      res.sendFile(indexFile)
    })
  } else {
    app.get('/', (_req, res) => {
      res
        .status(500)
        .type('text/plain')
        .send('前端构建产物不存在，请先运行 npm run build，或使用 npm run dev 以开发模式启动。')
    })
  }
}

// 全局错误处理：客户端错误映射为 413/400，避免被统一 500 吞掉
app.use((err: Error, _req: Request, res: Response, next: NextFunction) => {
  if (res.headersSent) {
    next(err)
    return
  }
  const detail = err as Error & { type?: string; status?: number; statusCode?: number }
  const status = detail.status || detail.statusCode || 0
  if (detail.type === 'entity.too.large' || status === 413) {
    res.status(413).json({ error: `请求体过大（上限 ${config.bodyLimit}）` })
    return
  }
  if (detail.type === 'entity.parse.failed' || (status === 400 && err instanceof SyntaxError)) {
    res.status(400).json({ error: '请求体不是合法的 JSON' })
    return
  }
  console.error('[api error]', err)
  res.status(500).json({ error: '服务器内部错误' })
})

markInterruptedRuns()
seedSamples()

app.listen(config.port, () => {
  console.log(`[atoms] listening on http://localhost:${config.port}  (mock=${isMockMode()}, db=${config.databasePath})`)
  if (isMockMode()) {
    console.log('[atoms] 未配置模型或 MOCK_MODE=1，当前使用内置模板演示模式')
  }
})
