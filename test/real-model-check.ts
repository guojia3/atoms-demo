// 真实模型链路轻量验证（E1 3100）：1 次创建 + 1 次编辑，记录模型名、耗时、Patch 命中与评分
// 用法：QA_BASE=http://127.0.0.1:3100 npx tsx test/real-model-check.ts
import fs from 'node:fs'
import path from 'node:path'
import { BASE, Jar, consumeRun, eq, http, ok, type RunEvent } from './qa-harness.js'

const prompt = '做一个任务看板，支持添加任务、勾选完成和删除任务，数据保存在浏览器本地'
const editPrompt = '把页面标题改成「我的任务看板」，并给每个任务增加优先级字段'

function summarize(events: RunEvent[]) {
  const candidates = events.find((e) => e.type === 'candidates')?.data?.candidates || []
  const report = events.find((e) => e.type === 'report')?.data
  const version = [...events].reverse().find((e) => e.type === 'version')?.data
  const done = [...events].reverse().find((e) => e.type === 'done')?.data
  return {
    candidates: candidates.map((c: any) => ({
      variant: c.variant,
      model: c.model,
      source: c.source,
      score: c.score,
      durationMs: c.durationMs,
      notes: c.notes,
      error: c.error,
    })),
    report: report && {
      score: report.score,
      reviewSource: report.reviewSource,
      conclusion: report.conclusion,
      notes: report.notes,
      checklist: report.checklist?.length,
    },
    version,
    doneStatus: done?.status,
  }
}

async function main(): Promise<void> {
  const jar = new Jar()
  const startedCreate = Date.now()
  const created = await http(jar, 'POST', '/api/projects', { prompt })
  eq(created.status, 201, '创建状态')
  const createEvents = await consumeRun(String(created.json.runId), jar, { timeoutMs: 300_000 })
  const createMs = Date.now() - startedCreate
  const created1 = summarize(createEvents)
  eq(created1.doneStatus, 'done', '创建终态')
  ok(created1.candidates.length >= 1, '无候选')

  const projectId = String(created.json.projectId)
  const detail1 = (await http(jar, 'GET', `/api/projects/${projectId}`)).json.project
  ok(detail1.versions.length === 1, 'v1 未保存')
  const v1 = detail1.versions[0]
  const htmlLength = detail1.html.length

  const startedEdit = Date.now()
  const edit = await http(jar, 'POST', `/api/projects/${projectId}/messages`, { content: editPrompt })
  eq(edit.status, 201, '编辑状态')
  const editEvents = await consumeRun(String(edit.json.runId), jar, { timeoutMs: 300_000 })
  const editMs = Date.now() - startedEdit
  const created2 = summarize(editEvents)
  eq(created2.doneStatus, 'done', '编辑终态')

  const detail2 = (await http(jar, 'GET', `/api/projects/${projectId}`)).json.project
  ok(detail2.versions.length === 2, 'v2 未保存')
  const v2 = detail2.versions[0]
  const changed = detail2.html !== detail1.html
  const patchNote = (created2.candidates[0]?.notes || []).join('；')

  const record = {
    base: BASE,
    projectId,
    create: { totalMs: createMs, ...created1, v1 },
    edit: { totalMs: editMs, ...created2, v2 },
    html: { v1Length: htmlLength, v2Length: detail2.html.length, changed, patchNote },
    verifiedAt: new Date().toISOString(),
  }
  const dir = path.resolve(process.cwd(), 'test/results')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'real-model.json'), JSON.stringify(record, null, 2))

  console.log(`[real] 创建：${createMs}ms，候选 ${created1.candidates.map((c: any) => `${c.model}(${c.source},${c.durationMs}ms)`).join(' / ')}，评分 ${created1.report?.score}，验收 ${created1.report?.reviewSource}`)
  console.log(`[real] v1：seq=${v1.seq} source=${v1.source} model=${v1.model} score=${v1.score} html=${htmlLength}`)
  console.log(`[real] 编辑：${editMs}ms，候选 ${created2.candidates.map((c: any) => `${c.model}(${c.source},${c.durationMs}ms)`).join(' / ')}，notes=${patchNote}`)
  console.log(`[real] v2：seq=${v2.seq} source=${v2.source} model=${v2.model} score=${v2.score} html=${detail2.html.length} changed=${changed}`)
}

void main()
