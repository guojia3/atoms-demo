// 运行配置：环境变量集中读取，所有模型 Key 只存在于服务端进程内，绝不返回给前端
import fs from 'node:fs'
import path from 'node:path'

try {
  // Node 21.7+ 内置 .env 读取；文件不存在时忽略
  process.loadEnvFile?.('.env')
} catch {
  /* noop */
}

export interface Provider {
  name: string
  baseUrl: string
  apiKey: string
  model: string
}

function loadProviders(): Provider[] {
  const raw = process.env.LLM_PROVIDERS?.trim()
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Array<Partial<Provider>>
      const list = parsed
        .filter((p) => p.baseUrl && p.model)
        .map((p) => ({
          name: String(p.name || p.model),
          baseUrl: String(p.baseUrl).replace(/\/+$/, ''),
          apiKey: String(p.apiKey || ''),
          model: String(p.model),
        }))
      if (list.length > 0) return list
    } catch (err) {
      console.warn('[config] LLM_PROVIDERS 解析失败，忽略:', (err as Error).message)
    }
  }
  const baseUrl = process.env.LLM_BASE_URL?.trim()
  const models = process.env.LLM_MODELS?.split(',').map((s) => s.trim()).filter(Boolean) ?? []
  if (baseUrl && models.length > 0) {
    return models.map((model) => ({
      name: model,
      baseUrl: baseUrl.replace(/\/+$/, ''),
      apiKey: process.env.LLM_API_KEY?.trim() || '',
      model,
    }))
  }
  return []
}

export const config = {
  port: Number(process.env.PORT || 3000),
  databasePath: process.env.DATABASE_PATH || './data/atoms.db',
  mockMode: process.env.MOCK_MODE === '1',
  providers: loadProviders(),
  probeTimeoutMs: Number(process.env.PROBE_TIMEOUT_MS || 15000),
  /** 请求体上限（express.json 的 limit），默认 1mb；同时用于 413 文案 */
  bodyLimit: process.env.BODY_LIMIT?.trim() || '1mb',
  /** 每用户每小时生成次数上限（创建、编辑、修复、重试都计入） */
  generationRateLimit: Math.max(1, Number(process.env.GENERATION_RATE_LIMIT || 20)),
  /** 允许的额外前端同源（逗号分隔），用于反向代理/多域名部署；同源始终放行 */
  publicOrigins: (process.env.PUBLIC_ORIGIN || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  /** 候选数量：1 = 单路生成，2 = 双路赛马（默认），最多 3 */
  raceCount: Math.max(1, Math.min(3, Number(process.env.RACE_COUNT || 2))),
  gitCommit: process.env.GIT_COMMIT || '',
  isProd: process.env.NODE_ENV === 'production',
  rootDir: process.cwd(),
  distDir: path.resolve(process.cwd(), 'dist/client'),
}

/** 无模型配置或显式 MOCK_MODE=1 时，整条链路走内置模板 */
export function isMockMode(): boolean {
  if (config.mockMode) return true
  return config.providers.length === 0
}

export function ensureDataDir(): void {
  const abs = path.resolve(config.databasePath)
  const dir = path.dirname(abs)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
}
