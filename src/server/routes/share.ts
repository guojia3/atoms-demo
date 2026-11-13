// 发布页：固定版本对外可见；访客数据按 visitor cookie 隔离
import { Router } from 'express'
import { randomBytes } from 'node:crypto'
import { getKv, applyKvOps, findProjectBySlug, getVersion } from '../store.js'
import { getCookies, isSecureRequest, VID_COOKIE } from '../auth.js'

const router = Router()

function visitorCookie(req: any, res: any): string {
  const existing = getCookies(req)[VID_COOKIE]
  if (existing && /^[a-zA-Z0-9]{8,64}$/.test(existing)) return existing
  const vid = randomBytes(8).toString('hex')
  res.cookie(VID_COOKIE, vid, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 30 * 24 * 3600 * 1000,
    secure: isSecureRequest(req),
  })
  return vid
}

function publishedProject(slug: string) {
  const project = findProjectBySlug(slug)
  if (!project || !project.published_version_id || !project.share_slug) return null
  const version = getVersion(project.published_version_id)
  if (!version) return null
  return { project, version }
}

/** 模板/回退/回退版本统一按模型名兜底判断，避免 restore 把内置模板误标成模型生成 */
function isTemplateVersion(version: { source: string; model: string | null }): boolean {
  return version.source === 'mock' || version.source === 'fallback' || version.model === 'atoms-mock'
}

router.get('/share/:slug', (req, res) => {
  const found = publishedProject(req.params.slug)
  if (!found) {
    res.status(404).json({ error: '链接不存在或已下线' })
    return
  }
  visitorCookie(req, res)
  res.json({
    projectId: found.project.id,
    title: found.project.title,
    prompt: found.project.prompt,
    html: found.version.html,
    seq: found.version.seq,
    score: found.version.score,
    publishedAt: found.version.created_at,
    source: found.version.source,
    model: found.version.model,
    // source: generate/edit 为真实模型产出；mock/fallback/atoms-mock（含回退）为内置模板
    mock: isTemplateVersion(found.version),
  })
})

router.get('/share/:slug/kv', (req, res) => {
  const found = publishedProject(req.params.slug)
  if (!found) {
    res.status(404).json({ error: '链接不存在或已下线' })
    return
  }
  const vid = visitorCookie(req, res)
  res.json({ data: getKv(found.project.id, `visitor:${vid}`) })
})

router.post('/share/:slug/kv', (req, res) => {
  const found = publishedProject(req.params.slug)
  if (!found) {
    res.status(404).json({ error: '链接不存在或已下线' })
    return
  }
  const vid = getCookies(req)[VID_COOKIE]
  if (!vid || !/^[a-zA-Z0-9]{8,64}$/.test(vid)) {
    res.status(400).json({ error: '缺少访客标识，请刷新页面' })
    return
  }
  const ops = Array.isArray(req.body?.ops) ? req.body.ops : []
  if (ops.length === 0) {
    res.json({ ok: true, applied: 0 })
    return
  }
  const result = applyKvOps(found.project.id, `visitor:${vid}`, ops)
  if (result.error) {
    res.status(400).json({ error: result.error })
    return
  }
  res.json({ ok: true, applied: result.applied })
})

export default router
