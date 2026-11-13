// 运行事件流（SSE）、候选结果页面、探针回报、停止任务
import { Router, type Request } from 'express'
import { eventsSince, lastSeq, subscribe } from '../jobs/hub.js'
import { executeRun, resolveReport, stopRun } from '../jobs/runner.js'
import { getCandidate, getProject, getRun, updateRun } from '../store.js'
import { serializeProject } from './projects.js'
import { takeGenerationQuota } from '../auth.js'
import type { ProbeMetrics } from '../verify/score.js'

const router = Router()

function ownedRun(req: Request, runId: string) {
  const run = getRun(runId)
  if (!run) return null
  const project = getProject(run.project_id)
  if (!project || project.user_id !== req.user.id) return null
  return run
}

function ownedCandidate(req: Request, candidateId: string) {
  const candidate = getCandidate(candidateId)
  if (!candidate) return null
  const run = getRun(candidate.run_id)
  if (!run) return null
  const project = getProject(run.project_id)
  if (!project || project.user_id !== req.user.id) return null
  return { candidate, run, project }
}

router.get('/runs/:id/events', (req, res) => {
  const run = ownedRun(req, req.params.id)
  if (!run) {
    res.status(404).json({ error: '任务不存在' })
    return
  }
  const from = Number(req.query.from || 0)

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })

  const send = (payload: unknown) => {
    res.write(`data: ${JSON.stringify(payload)}\n\n`)
  }

  res.write(': atoms stream open\n\n')
  const project = getProject(run.project_id)
  send({
    type: 'snapshot',
    data: {
      run: { id: run.id, status: run.status, mode: run.mode, instruction: run.instruction },
      project: project ? serializeProject(project.id) : null,
    },
  })

  for (const event of eventsSince(run.id, from)) {
    send(event)
  }

  const finished = run.status !== 'running'
  if (finished) {
    send({ type: 'done', data: { runId: run.id, status: run.status, replayed: true } })
    res.end()
    return
  }

  const unsubscribe = subscribe(run.id, (event) => send(event))
  const heartbeat = setInterval(() => {
    res.write(': ping\n\n')
  }, 15000)

  req.on('close', () => {
    clearInterval(heartbeat)
    unsubscribe()
  })
})

router.post('/runs/:id/stop', (req, res) => {
  const run = ownedRun(req, req.params.id)
  if (!run) {
    res.status(404).json({ error: '任务不存在' })
    return
  }
  stopRun(run.id)
  res.json({ ok: true })
})

router.get('/candidates/:id/html', (req, res) => {
  const owned = ownedCandidate(req, req.params.id)
  if (!owned) {
    res.status(404).json({ error: '候选不存在' })
    return
  }
  if (!owned.candidate.html) {
    res.status(409).json({ error: '候选页面尚未生成' })
    return
  }
  res.json({ html: owned.candidate.html, model: owned.candidate.model, status: owned.candidate.status })
})

router.post('/candidates/:id/report', (req, res) => {
  const owned = ownedCandidate(req, req.params.id)
  if (!owned) {
    res.status(404).json({ error: '候选不存在' })
    return
  }
  const m = req.body?.metrics
  if (!m || typeof m !== 'object') {
    res.status(400).json({ error: '缺少实测数据' })
    return
  }
  const num = (v: unknown, max = 100000): number => {
    const n = Number(v)
    if (!Number.isFinite(n) || n < 0) return 0
    return Math.min(Math.floor(n), max)
  }
  const metrics: ProbeMetrics = {
    elements: num(m.elements, 5000),
    textLength: num(m.textLength, 200000),
    errors: Array.isArray(m.errors) ? m.errors.slice(0, 20).map((e: unknown) => String(e).slice(0, 300)) : [],
    errorCount: num(m.errorCount, 50),
    clicks: num(m.clicks, 1000),
    mutations: num(m.mutations, 100000),
    keys: num(m.keys, 500),
    writes: num(m.writes, 100000),
    overflowX: Boolean(m.overflowX),
    width: num(m.width, 4000),
    title: String(m.title || '').slice(0, 120),
    interactiveClicks: num(m.interactiveClicks, 1000),
    simulatedClicks: num(m.simulatedClicks, 100),
    simulatedChanges: num(m.simulatedChanges, 10000),
    simulatedWrites: num(m.simulatedWrites, 1000),
  }
  const accepted = resolveReport(owned.candidate.id, metrics)
  res.json({ ok: true, accepted })
})

// 供"一键修复"等场景复用：用最近的失败信息重跑编辑
router.post('/runs/:id/retry', (req, res) => {
  const run = ownedRun(req, req.params.id)
  if (!run) {
    res.status(404).json({ error: '任务不存在' })
    return
  }
  const project = getProject(run.project_id)
  if (!project) {
    res.status(404).json({ error: '项目不存在' })
    return
  }
  if (run.status === 'running') {
    res.status(409).json({ error: '任务仍在进行中' })
    return
  }
  if (!takeGenerationQuota(req, res)) return
  updateRun(run.id, { status: 'running', error: null, finished_at: null })
  void executeRun(run.id)
  res.json({ ok: true, runId: run.id })
})

export default router
