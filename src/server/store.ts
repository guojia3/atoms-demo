// 数据访问层：手写 SQL，薄封装，便于阅读与迁移
import { createHash, randomUUID } from 'node:crypto'
import { getOne, getAll, run, transaction, now } from './db.js'
import type { UserRow, ProjectRow, VersionRow, MessageRow, RunRow, CandidateRow } from './db.js'

export function uid(): string {
  return randomUUID()
}

/* ---------------- 用户与会话 ---------------- */

export function createGuestUser(): UserRow {
  const user: UserRow = {
    id: uid(),
    kind: 'guest',
    email: null,
    name: '游客',
    password_hash: null,
    created_at: now(),
  }
  run(
    'INSERT INTO users (id, kind, email, name, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    user.id,
    user.kind,
    user.email,
    user.name,
    user.password_hash,
    user.created_at,
  )
  return user
}

export function createEmailUser(email: string, passwordHash: string, name: string): UserRow {
  const user: UserRow = {
    id: uid(),
    kind: 'email',
    email,
    name,
    password_hash: passwordHash,
    created_at: now(),
  }
  run(
    'INSERT INTO users (id, kind, email, name, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    user.id,
    user.kind,
    user.email,
    user.name,
    user.password_hash,
    user.created_at,
  )
  return user
}

export function findUserByEmail(email: string): UserRow | undefined {
  return getOne<UserRow>('SELECT * FROM users WHERE lower(email) = lower(?)', email)
}

export function findUserById(id: string): UserRow | undefined {
  return getOne<UserRow>('SELECT * FROM users WHERE id = ?', id)
}

export function upgradeGuestToEmail(userId: string, email: string, passwordHash: string, name: string): UserRow {
  run(
    "UPDATE users SET kind = 'email', email = ?, password_hash = ?, name = ? WHERE id = ? AND kind = 'guest'",
    email,
    passwordHash,
    name,
    userId,
  )
  return findUserById(userId)!
}

export function createSession(userId: string, days = 7): string {
  const token = randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '')
  const tokenHash = sha256(token)
  const expires = new Date(Date.now() + days * 24 * 3600 * 1000).toISOString()
  run(
    'INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)',
    tokenHash,
    userId,
    expires,
    now(),
  )
  // 顺手清理过期会话，避免表膨胀
  run('DELETE FROM sessions WHERE expires_at < ?', now())
  return token
}

export function findUserBySessionToken(token: string): UserRow | undefined {
  const tokenHash = sha256(token)
  return getOne<UserRow>(
    `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > ?`,
    tokenHash,
    now(),
  )
}

export function deleteSession(token: string): void {
  run('DELETE FROM sessions WHERE token_hash = ?', sha256(token))
}

export function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex')
}

/* ---------------- 项目 ---------------- */

export function createProject(userId: string, title: string, prompt: string): ProjectRow {
  const t = now()
  const project: ProjectRow = {
    id: uid(),
    user_id: userId,
    title,
    prompt,
    plan_json: null,
    checklist_json: null,
    current_version_id: null,
    published_version_id: null,
    share_slug: null,
    created_at: t,
    updated_at: t,
  }
  run(
    `INSERT INTO projects (id, user_id, title, prompt, plan_json, checklist_json, current_version_id,
      published_version_id, share_slug, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    project.id,
    project.user_id,
    project.title,
    project.prompt,
    project.plan_json,
    project.checklist_json,
    project.current_version_id,
    project.published_version_id,
    project.share_slug,
    project.created_at,
    project.updated_at,
  )
  return project
}

export function getProject(id: string): ProjectRow | undefined {
  return getOne<ProjectRow>('SELECT * FROM projects WHERE id = ?', id)
}

export function listProjects(userId: string): Array<ProjectRow & { version_count: number; current_score: number | null }> {
  return getAll<ProjectRow & { version_count: number; current_score: number | null }>(
    `SELECT p.*,
      (SELECT COUNT(*) FROM versions v WHERE v.project_id = p.id) AS version_count,
      (SELECT score FROM versions v WHERE v.id = p.current_version_id) AS current_score
     FROM projects p WHERE p.user_id = ? ORDER BY p.updated_at DESC LIMIT 60`,
    userId,
  )
}

export function touchProject(id: string, fields: Partial<Pick<ProjectRow, 'title' | 'plan_json' | 'checklist_json' | 'current_version_id' | 'published_version_id' | 'share_slug'>>): void {
  const keys = Object.keys(fields)
  if (keys.length === 0) return
  const setSql = keys.map((k) => `${k} = ?`).join(', ')
  run(`UPDATE projects SET ${setSql}, updated_at = ? WHERE id = ?`, ...keys.map((k) => fields[k as keyof typeof fields]), now(), id)
}

export function deleteProject(id: string): void {
  run('DELETE FROM projects WHERE id = ?', id)
}

export function findProjectBySlug(slug: string): ProjectRow | undefined {
  return getOne<ProjectRow>('SELECT * FROM projects WHERE share_slug = ?', slug)
}

/** 首页示例：取已发布的公开项目 */
export function listSamples(limit = 6): Array<ProjectRow & { current_score: number | null }> {
  return getAll<ProjectRow & { current_score: number | null }>(
    `SELECT p.*, (SELECT score FROM versions v WHERE v.id = p.current_version_id) AS current_score
     FROM projects p
     WHERE p.published_version_id IS NOT NULL AND p.share_slug IS NOT NULL
     ORDER BY p.created_at ASC LIMIT ?`,
    limit,
  )
}

/* ---------------- 版本 ---------------- */

export function createVersion(input: {
  projectId: string
  html: string
  model: string
  source: string
  score?: number | null
  report?: unknown
}): VersionRow {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return transaction(() => {
        const max = getOne<{ m: number | null }>('SELECT MAX(seq) AS m FROM versions WHERE project_id = ?', input.projectId)
        const seq = (max?.m ?? 0) + 1
        const version: VersionRow = {
          id: uid(),
          project_id: input.projectId,
          seq,
          html: input.html,
          model: input.model,
          source: input.source,
          score: input.score ?? null,
          report_json: input.report ? JSON.stringify(input.report) : null,
          created_at: now(),
        }
        run(
          `INSERT INTO versions (id, project_id, seq, html, model, source, score, report_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          version.id,
          version.project_id,
          version.seq,
          version.html,
          version.model,
          version.source,
          version.score,
          version.report_json,
          version.created_at,
        )
        return version
      })
    } catch (err) {
      if (attempt === 2) throw err
    }
  }
  throw new Error('创建版本失败')
}

export function getVersion(id: string): VersionRow | undefined {
  return getOne<VersionRow>('SELECT * FROM versions WHERE id = ?', id)
}

export function listVersions(projectId: string): VersionRow[] {
  return getAll<VersionRow>('SELECT * FROM versions WHERE project_id = ? ORDER BY seq DESC', projectId)
}

/* ---------------- 消息 ---------------- */

export function addMessage(input: {
  projectId: string
  role: 'user' | 'agent' | 'system'
  kind?: string
  content: string
  meta?: unknown
}): MessageRow {
  const message: MessageRow = {
    id: uid(),
    project_id: input.projectId,
    role: input.role,
    kind: input.kind || 'text',
    content: input.content,
    meta_json: input.meta ? JSON.stringify(input.meta) : null,
    created_at: now(),
  }
  run(
    'INSERT INTO messages (id, project_id, role, kind, content, meta_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    message.id,
    message.project_id,
    message.role,
    message.kind,
    message.content,
    message.meta_json,
    message.created_at,
  )
  return message
}

export function listMessages(projectId: string): MessageRow[] {
  return getAll<MessageRow>('SELECT * FROM messages WHERE project_id = ? ORDER BY created_at ASC, rowid ASC', projectId)
}

/* ---------------- 运行与候选 ---------------- */

export function createRun(input: { projectId: string; mode: string; instruction?: string; baseVersionId?: string | null; models: string[] }): RunRow {
  const r: RunRow = {
    id: uid(),
    project_id: input.projectId,
    mode: input.mode,
    status: 'running',
    instruction: input.instruction || '',
    base_version_id: input.baseVersionId || null,
    models_json: JSON.stringify(input.models),
    error: null,
    started_at: now(),
    finished_at: null,
  }
  run(
    `INSERT INTO runs (id, project_id, mode, status, instruction, base_version_id, models_json, error, started_at, finished_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    r.id,
    r.project_id,
    r.mode,
    r.status,
    r.instruction,
    r.base_version_id,
    r.models_json,
    r.error,
    r.started_at,
    r.finished_at,
  )
  return r
}

export function getRun(id: string): RunRow | undefined {
  return getOne<RunRow>('SELECT * FROM runs WHERE id = ?', id)
}

export function updateRun(id: string, fields: { status?: string; error?: string | null; finished_at?: string | null }): void {
  const keys = Object.keys(fields)
  if (keys.length === 0) return
  run(
    `UPDATE runs SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`,
    ...keys.map((k) => fields[k as keyof typeof fields]),
    id,
  )
}

export function createCandidate(input: { runId: string; model: string }): CandidateRow {
  const c: CandidateRow = {
    id: uid(),
    run_id: input.runId,
    model: input.model,
    status: 'running',
    html: null,
    error: null,
    duration_ms: null,
    score: null,
    report_json: null,
    created_at: now(),
  }
  run(
    'INSERT INTO candidates (id, run_id, model, status, html, error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    c.id,
    c.run_id,
    c.model,
    c.status,
    c.html,
    c.error,
    c.created_at,
  )
  return c
}

export function updateCandidate(
  id: string,
  fields: Partial<Pick<CandidateRow, 'status' | 'html' | 'error' | 'duration_ms' | 'score' | 'report_json'>>,
): void {
  const keys = Object.keys(fields)
  if (keys.length === 0) return
  run(`UPDATE candidates SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...keys.map((k) => fields[k as keyof typeof fields]), id)
}

export function getCandidate(id: string): CandidateRow | undefined {
  return getOne<CandidateRow>('SELECT * FROM candidates WHERE id = ?', id)
}

export function listCandidates(runId: string): CandidateRow[] {
  return getAll<CandidateRow>('SELECT * FROM candidates WHERE run_id = ? ORDER BY created_at ASC', runId)
}

export function getActiveRun(projectId: string): RunRow | undefined {
  return getOne<RunRow>(
    "SELECT * FROM runs WHERE project_id = ? AND status = 'running' ORDER BY started_at DESC LIMIT 1",
    projectId,
  )
}

export function markInterruptedRuns(): number {
  const { changes } = run("UPDATE runs SET status = 'interrupted', finished_at = ? WHERE status = 'running'", now())
  return changes
}

/* ---------------- 生成应用的数据（KV） ---------------- */

export interface KvOp {
  op: 'set' | 'del' | 'clear'
  key?: string
  value?: string
}

export function getKv(projectId: string, scope: string): Record<string, string> {
  const rows = getAll<{ key: string; value: string }>(
    'SELECT key, value FROM app_data WHERE project_id = ? AND scope = ?',
    projectId,
    scope,
  )
  const data: Record<string, string> = {}
  for (const row of rows) data[row.key] = row.value
  return data
}

export function applyKvOps(projectId: string, scope: string, ops: KvOp[]): { applied: number; error?: string } {
  // 校验：单键 ≤200 字符、单值 ≤200KB、单作用域 ≤200 键
  const current = getKv(projectId, scope)
  const next = { ...current }
  for (const op of ops) {
    if (op.op === 'set') {
      if (typeof op.key !== 'string' || op.key.length === 0 || op.key.length > 200) return { applied: 0, error: '键名不合法（长度需 1-200）' }
      if (typeof op.value !== 'string' || op.value.length > 200 * 1024) return { applied: 0, error: '单值超过 200KB 限制' }
      next[op.key] = op.value
    } else if (op.op === 'del') {
      if (typeof op.key === 'string') delete next[op.key]
    } else if (op.op === 'clear') {
      for (const k of Object.keys(next)) delete next[k]
    } else {
      return { applied: 0, error: '未知操作' }
    }
  }
  if (Object.keys(next).length > 200) return { applied: 0, error: '单个作用域最多 200 个键' }

  transaction(() => {
    const t = now()
    for (const op of ops) {
      if (op.op === 'set') {
        run(
          `INSERT INTO app_data (project_id, scope, key, value, updated_at) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(project_id, scope, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
          projectId,
          scope,
          op.key!,
          op.value!,
          t,
        )
      } else if (op.op === 'del') {
        run('DELETE FROM app_data WHERE project_id = ? AND scope = ? AND key = ?', projectId, scope, op.key!)
      } else if (op.op === 'clear') {
        run('DELETE FROM app_data WHERE project_id = ? AND scope = ?', projectId, scope)
      }
    }
  })
  return { applied: ops.length }
}

export function clearVisitorKv(projectId: string): void {
  run("DELETE FROM app_data WHERE project_id = ? AND scope LIKE 'visitor:%'", projectId)
}
