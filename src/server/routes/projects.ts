// 项目与版本：创建、详情、编辑、版本回退、发布、生成应用数据
import { Router } from 'express'
import { randomBytes } from 'node:crypto'
import {
  addMessage,
  applyKvOps,
  clearVisitorKv,
  createProject,
  createRun,
  createVersion,
  deleteProject,
  findProjectBySlug,
  getActiveRun,
  getKv,
  getProject,
  getVersion,
  listMessages,
  listProjects,
  listSamples,
  listVersions,
  touchProject,
} from '../store.js'
import { executeRun } from '../jobs/runner.js'
import { isMockMode, config } from '../config.js'
import { takeGenerationQuota } from '../auth.js'
import { pickTemplate } from '../mock/templates.js'

const router = Router()

function parseJson<T>(input: string | null): T | null {
  if (!input) return null
  try {
    return JSON.parse(input) as T
  } catch {
    return null
  }
}

function randomSlug(len = 7): string {
  const chars = 'abcdefghijkmnpqrstuvwxyz23456789'
  const bytes = randomBytes(len)
  let out = ''
  for (let i = 0; i < len; i++) out += chars[bytes[i] % chars.length]
  return out
}

function uniqueSlug(): string {
  for (let i = 0; i < 10; i++) {
    const slug = randomSlug()
    if (!findProjectBySlug(slug)) return slug
  }
  return randomSlug(8) + String(Date.now()).slice(-2)
}

function modelLabel(): string {
  if (isMockMode()) return 'atoms-mock'
  return config.providers[0]?.model || 'unknown'
}

export function serializeProject(projectId: string) {
  const project = getProject(projectId)
  if (!project) return null
  const versions = listVersions(project.id)
  const currentVersion = project.current_version_id ? getVersion(project.current_version_id) : null
  const publishedVersion = project.published_version_id ? getVersion(project.published_version_id) : null
  const messages = listMessages(project.id).map((m) => ({
    id: m.id,
    role: m.role,
    kind: m.kind,
    content: m.content,
    meta: parseJson<unknown>(m.meta_json),
    createdAt: m.created_at,
  }))
  return {
    id: project.id,
    title: project.title,
    prompt: project.prompt,
    plan: parseJson<unknown>(project.plan_json),
    checklist: parseJson<unknown>(project.checklist_json),
    currentVersionId: project.current_version_id,
    publishedVersionId: project.published_version_id,
    shareSlug: project.share_slug,
    createdAt: project.created_at,
    updatedAt: project.updated_at,
    html: currentVersion?.html || '',
    versions: versions.map((v) => ({
      id: v.id,
      seq: v.seq,
      source: v.source,
      score: v.score,
      model: v.model,
      createdAt: v.created_at,
    })),
    publishedVersionSeq: publishedVersion?.seq ?? null,
    messages,
    activeRunId: getActiveRun(project.id)?.id ?? null,
  }
}

router.get('/projects', (req, res) => {
  const rows = listProjects(req.user.id)
  res.json({
    projects: rows.map((p) => ({
      id: p.id,
      title: p.title,
      prompt: p.prompt,
      updatedAt: p.updated_at,
      versionCount: p.version_count,
      score: p.current_score,
      shareSlug: p.share_slug,
      published: Boolean(p.published_version_id),
    })),
  })
})

router.post('/projects', (req, res) => {
  const prompt = typeof req.body?.prompt === 'string' ? req.body.prompt.trim() : ''
  if (prompt.length < 4) {
    res.status(400).json({ error: '请至少输入 4 个字描述你要做的应用' })
    return
  }
  if (prompt.length > 400) {
    res.status(400).json({ error: '需求描述最多 400 字' })
    return
  }
  if (!takeGenerationQuota(req, res)) return
  const project = createProject(req.user.id, prompt.slice(0, 20), prompt)
  const run = createRun({ projectId: project.id, mode: 'create', models: [modelLabel()] })
  void executeRun(run.id)
  res.status(201).json({ projectId: project.id, runId: run.id })
})

router.get('/samples', (_req, res) => {
  res.json({
    samples: listSamples(8).map((p) => ({
      id: p.id,
      title: p.title,
      prompt: p.prompt,
      slug: p.share_slug,
      score: p.current_score,
      kind: pickTemplate(p.prompt),
    })),
  })
})

router.get('/projects/:id', (req, res) => {
  const project = getProject(req.params.id)
  if (!project || project.user_id !== req.user.id) {
    res.status(404).json({ error: '项目不存在' })
    return
  }
  res.json({ project: serializeProject(project.id) })
})

router.patch('/projects/:id', (req, res) => {
  const project = getProject(req.params.id)
  if (!project || project.user_id !== req.user.id) {
    res.status(404).json({ error: '项目不存在' })
    return
  }
  const title = typeof req.body?.title === 'string' ? req.body.title.trim().slice(0, 40) : ''
  if (!title) {
    res.status(400).json({ error: '标题不能为空' })
    return
  }
  touchProject(project.id, { title })
  res.json({ ok: true, title })
})

router.delete('/projects/:id', (req, res) => {
  const project = getProject(req.params.id)
  if (!project || project.user_id !== req.user.id) {
    res.status(404).json({ error: '项目不存在' })
    return
  }
  deleteProject(project.id)
  res.json({ ok: true })
})

// 编辑（迭代）：追加用户消息并启动新 run；失败不会覆盖当前版本
router.post('/projects/:id/messages', (req, res) => {
  const project = getProject(req.params.id)
  if (!project || project.user_id !== req.user.id) {
    res.status(404).json({ error: '项目不存在' })
    return
  }
  const content = typeof req.body?.content === 'string' ? req.body.content.trim() : ''
  if (content.length < 2) {
    res.status(400).json({ error: '请说明要改什么' })
    return
  }
  if (!project.current_version_id) {
    res.status(400).json({ error: '当前还没有可用版本，不能迭代' })
    return
  }
  const active = getActiveRun(project.id)
  if (active) {
    res.status(409).json({ error: '当前有任务正在进行，请等待完成或先停止' })
    return
  }
  if (!takeGenerationQuota(req, res)) return
  addMessage({ projectId: project.id, role: 'user', kind: 'text', content })

  // 点选编辑：把元素上下文拼进给模型的指令，但不写入展示用的消息内容
  const rawTarget = req.body?.target
  let instruction = content
  if (rawTarget && typeof rawTarget === 'object') {
    const selector = String((rawTarget as Record<string, unknown>).selector || '').slice(0, 200)
    const tag = String((rawTarget as Record<string, unknown>).tag || '').slice(0, 20)
    const text = String((rawTarget as Record<string, unknown>).text || '').slice(0, 80)
    const snippet = String((rawTarget as Record<string, unknown>).html || '').slice(0, 1200)
    const parts = [`【点选元素】selector: ${selector || '(unknown)'}；标签: ${tag || 'unknown'}；文本: ${text || '(空)'}`]
    if (snippet) parts.push(`元素当前 HTML 片段：\n${snippet}`)
    parts.push(`修改要求：${content}`)
    instruction = parts.join('\n')
  }

  const run = createRun({
    projectId: project.id,
    mode: req.body?.mode === 'fix' ? 'fix' : 'edit',
    instruction,
    baseVersionId: project.current_version_id,
    models: [modelLabel()],
  })
  void executeRun(run.id)
  res.status(201).json({ runId: run.id })
})

router.post('/projects/:id/publish', (req, res) => {
  const project = getProject(req.params.id)
  if (!project || project.user_id !== req.user.id) {
    res.status(404).json({ error: '项目不存在' })
    return
  }
  if (!project.current_version_id) {
    res.status(400).json({ error: '还没有可发布的版本' })
    return
  }
  const slug = project.share_slug || uniqueSlug()
  touchProject(project.id, { published_version_id: project.current_version_id, share_slug: slug })
  res.json({ slug, path: `/s/${slug}`, publishedVersionSeq: getVersion(project.current_version_id)?.seq ?? null })
})

router.post('/projects/:id/unpublish', (req, res) => {
  const project = getProject(req.params.id)
  if (!project || project.user_id !== req.user.id) {
    res.status(404).json({ error: '项目不存在' })
    return
  }
  clearVisitorKv(project.id)
  touchProject(project.id, { published_version_id: null })
  res.json({ ok: true })
})

router.post('/projects/:id/versions/:vid/restore', (req, res) => {
  const project = getProject(req.params.id)
  if (!project || project.user_id !== req.user.id) {
    res.status(404).json({ error: '项目不存在' })
    return
  }
  const version = getVersion(req.params.vid)
  if (!version || version.project_id !== project.id) {
    res.status(404).json({ error: '版本不存在' })
    return
  }
  const restored = createVersion({
    projectId: project.id,
    html: version.html,
    model: version.model || 'restore',
    source: 'restore',
    score: version.score,
    report: parseJson(version.report_json),
  })
  touchProject(project.id, { current_version_id: restored.id })
  addMessage({
    projectId: project.id,
    role: 'agent',
    kind: 'version',
    content: `已从 v${version.seq} 恢复为 v${restored.seq}`,
    meta: { versionId: restored.id, seq: restored.seq, restoredFrom: version.seq, score: restored.score, adopted: true },
  })
  res.json({ version: { id: restored.id, seq: restored.seq } })
})

router.get('/projects/:id/versions/:vid/html', (req, res) => {
  const project = getProject(req.params.id)
  if (!project || project.user_id !== req.user.id) {
    res.status(404).json({ error: '项目不存在' })
    return
  }
  const version = getVersion(req.params.vid)
  if (!version || version.project_id !== project.id) {
    res.status(404).json({ error: '版本不存在' })
    return
  }
  res.json({ html: version.html, seq: version.seq })
})

// 所有者作用域的生成应用数据
router.get('/projects/:id/kv', (req, res) => {
  const project = getProject(req.params.id)
  if (!project || project.user_id !== req.user.id) {
    res.status(404).json({ error: '项目不存在' })
    return
  }
  res.json({ data: getKv(project.id, 'owner') })
})

router.post('/projects/:id/kv', (req, res) => {
  const project = getProject(req.params.id)
  if (!project || project.user_id !== req.user.id) {
    res.status(404).json({ error: '项目不存在' })
    return
  }
  const ops = Array.isArray(req.body?.ops) ? req.body.ops : []
  if (ops.length === 0) {
    res.json({ ok: true, applied: 0 })
    return
  }
  const result = applyKvOps(project.id, 'owner', ops)
  if (result.error) {
    res.status(400).json({ error: result.error })
    return
  }
  res.json({ ok: true, applied: result.applied })
})

export default router
