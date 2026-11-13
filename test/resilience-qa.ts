// QA 异常/韧性自动化：针对 3201（假模型 3999），验证 402/429/断流/补丁失败/停止/重连/探针超时
// 用法：QA_BASE=http://127.0.0.1:3201 npx tsx test/resilience-qa.ts
import fs from 'node:fs'
import path from 'node:path'
import { BASE, FULL_METRICS, Jar, consumeRun, eq, http, ok, runCase, writeResults, type RunEvent } from './qa-harness.js'

async function readSse(
  runId: string,
  jar: Jar,
  opts: {
    from?: number
    timeoutMs?: number
    onEvent?: (event: RunEvent) => Promise<void> | void
    until: (event: RunEvent) => boolean
  },
): Promise<RunEvent[]> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 30_000)
  const events: RunEvent[] = []
  try {
    const res = await fetch(`${BASE}/api/runs/${runId}/events?from=${opts.from ?? 0}`, {
      headers: { cookie: jar.header() },
      signal: controller.signal,
    })
    if (!res.ok || !res.body) throw new Error(`SSE ${res.status}`)
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const blocks = buffer.split('\n\n')
      buffer = blocks.pop() || ''
      for (const block of blocks) {
        const line = block.split('\n').find((l) => l.startsWith('data:'))
        if (!line) continue
        const event = JSON.parse(line.slice(5).trim()) as RunEvent
        events.push(event)
        await opts.onEvent?.(event)
        if (opts.until(event)) {
          await reader.cancel().catch(() => {})
          return events
        }
      }
    }
    return events
  } finally {
    clearTimeout(timer)
  }
}

async function main(): Promise<void> {
  console.log(`[resilience] base = ${BASE}`)

  const fallback402 = new Jar()
  await runCase(
    {
      id: 'EX01',
      title: '模型 402：创作任务降级为内置模板，仍产出可预览版本',
      priority: 'P0',
      req: 'A6/H3',
      expected: 'done；candidate source=fallback；version source=fallback；notes 含降级说明',
    },
    async () => {
      const created = await http(fallback402, 'POST', '/api/projects', { prompt: 'HTTP402 做一个任务看板，支持添加任务' })
      eq(created.status, 201, '创建状态')
      const events = await consumeRun(String(created.json.runId), fallback402, { timeoutMs: 20_000 })
      const done = events.find((e) => e.type === 'done')
      eq(done?.data?.status, 'done', '终态')
      const candidate = events.find((e) => e.type === 'candidates')?.data?.candidates?.[0]
      eq(candidate?.source, 'fallback', '候选来源')
      const project = (await http(fallback402, 'GET', `/api/projects/${created.json.projectId}`)).json.project
      eq(project.versions[0].source, 'fallback', '版本来源')
      const report = events.find((e) => e.type === 'report')?.data
      ok(String(report?.notes || '').includes('降级'), '缺少降级说明')
      return `降级成功，v1=${project.versions[0].score} 分，notes=${report.notes}`
    },
  )

  let shareSlug = ''
  let retryProjectId = ''
  let retryCookie = ''
  await runCase(
    {
      id: 'EX02',
      title: '模型 429：同一次请求退避重试后成功，版本来源为模型',
      priority: 'P0',
      req: 'A6/H3',
      expected: '首个请求 429，自动重试成功；version source=generate',
    },
    async () => {
      const jar = new Jar()
      const created = await http(jar, 'POST', '/api/projects', { prompt: 'FLAKY429 做一个任务看板，支持添加任务' })
      eq(created.status, 201, '创建状态')
      const events = await consumeRun(String(created.json.runId), jar, { timeoutMs: 20_000 })
      eq(events.find((e) => e.type === 'done')?.data?.status, 'done', '终态')
      const project = (await http(jar, 'GET', `/api/projects/${created.json.projectId}`)).json.project
      eq(project.versions[0].source, 'generate', '版本来源')
      ok(project.html.includes('QA Demo'), '生成内容不是假模型 HTML')
      const pub = await http(jar, 'POST', `/api/projects/${created.json.projectId}/publish`)
      shareSlug = pub.json.slug
      retryProjectId = created.json.projectId
      retryCookie = jar.header()
      return `429 重试成功，version=generate，已发布 /s/${shareSlug}`
    },
  )

  await runCase(
    {
      id: 'EX03',
      title: '模型断流（半截 HTML）：静态检查失败后降级模板',
      priority: 'P0',
      req: 'A6',
      expected: 'done；version source=fallback；不保存半截页面',
    },
    async () => {
      const jar = new Jar()
      const created = await http(jar, 'POST', '/api/projects', { prompt: 'CUTSTREAM 做一个习惯打卡应用' })
      const events = await consumeRun(String(created.json.runId), jar, { timeoutMs: 20_000 })
      eq(events.find((e) => e.type === 'done')?.data?.status, 'done', '终态')
      const project = (await http(jar, 'GET', `/api/projects/${created.json.projectId}`)).json.project
      eq(project.versions[0].source, 'fallback', '版本来源')
      ok(project.html.includes('</html>'), '保存了不完整 HTML')
      return `半截输出被拒绝，降级为 ${project.versions[0].score} 分模板`
    },
  )

  await runCase(
    {
      id: 'EX04',
      title: '规划输出非 JSON：回退内置方案，生成仍可继续',
      priority: 'P1',
      req: 'A6/R7',
      expected: 'plan.source=mock，notes 含已切换；最终 version source=generate',
    },
    async () => {
      const jar = new Jar()
      const created = await http(jar, 'POST', '/api/projects', { prompt: 'BADPLAN 做一个任务看板' })
      const events = await consumeRun(String(created.json.runId), jar, { timeoutMs: 20_000 })
      const planEvent = events.find((e) => e.type === 'plan')
      const plan = planEvent?.data?.plan
      eq(plan?.source, 'mock', '规划来源')
      ok(String(plan?.notes || '').includes('内置方案'), '缺少回退说明')
      const project = (await http(jar, 'GET', `/api/projects/${created.json.projectId}`)).json.project
      eq(project.versions[0].source, 'generate', '生成来源')
      return `规划回退 ${plan.notes}；生成 ${project.versions[0].score} 分`
    },
  )

  const patchJar = new Jar()
  let patchProject = ''
  await runCase(
    {
      id: 'EX05',
      title: 'Patch 迭代：命中局部补丁并生成 v2，v1 保留',
      priority: 'P0',
      req: 'R7/A5/H7',
      expected: 'v2 source=edit，HTML 含修改标记，v1 不变',
    },
    async () => {
      const created = await http(patchJar, 'POST', '/api/projects', { prompt: '做一个任务看板，支持添加任务' })
      eq(created.status, 201, '创建')
      await consumeRun(String(created.json.runId), patchJar)
      const v1 = (await http(patchJar, 'GET', `/api/projects/${created.json.projectId}`)).json.project
      const edit = await http(patchJar, 'POST', `/api/projects/${created.json.projectId}/messages`, {
        content: 'PATCHME 请把标题改成 QA Demo 已修改',
      })
      eq(edit.status, 201, '编辑状态')
      const events = await consumeRun(String(edit.json.runId), patchJar)
      eq(events.find((e) => e.type === 'done')?.data?.status, 'done', '编辑终态')
      const v2 = (await http(patchJar, 'GET', `/api/projects/${created.json.projectId}`)).json.project
      eq(v2.versions.length, 2, '版本数')
      eq(v2.versions[0].source, 'edit', 'v2 来源')
      ok(v2.html.includes('QA Demo 已修改'), '补丁未生效')
      eq(v2.versions.find((v: any) => v.seq === 1)?.html === undefined, true, '版本列表不含 HTML') // 列表接口不返回 HTML
      eq(v1.html === v2.html, false, 'v1/v2 HTML 相同')
      patchProject = created.json.projectId
      return `v2 生效（source=${v2.versions[0].source}），v1 保留`
    },
  )

  await runCase(
    {
      id: 'EX06',
      title: 'Patch 定位失败且全量重写失败：不覆盖当前版本，任务失败可重试',
      priority: 'P0',
      req: 'H7/A11',
      expected: 'done=failed；versions 数量不变；当前版本仍为 v2',
    },
    async () => {
      ok(patchProject, '缺少前置项目')
      const before = (await http(patchJar, 'GET', `/api/projects/${patchProject}`)).json.project
      const edit = await http(patchJar, 'POST', `/api/projects/${patchProject}/messages`, { content: 'BADPATCH 随便改一下' })
      eq(edit.status, 201, '编辑启动')
      const events = await consumeRun(String(edit.json.runId), patchJar, { timeoutMs: 20_000 })
      eq(events.find((e) => e.type === 'done')?.data?.status, 'failed', '终态应为失败')
      ok(events.some((e) => e.type === 'error'), '缺少 error 事件')
      const after = (await http(patchJar, 'GET', `/api/projects/${patchProject}`)).json.project
      eq(after.versions.length, before.versions.length, '失败后版本数变化')
      eq(after.currentVersionId, before.currentVersionId, '失败后当前版本被覆盖')
      return `失败未覆盖：仍为 v2、${after.versions.length} 个版本`
    },
  )

  await runCase(
    {
      id: 'EX07',
      title: '生成中停止任务：终态应为 stopped，且不产生版本',
      priority: 'P1',
      req: 'A11',
      expected: '停止后终态 stopped；versions=0；当前实现可能被后续失败覆盖为 failed',
      defect: 'DEF-08',
      severity: 'S3',
    },
    async () => {
      const jar = new Jar()
      const created = await http(jar, 'POST', '/api/projects', { prompt: 'SLOWSTOP 做一个任务看板' })
      const runId = String(created.json.runId)
      let stopped = false
      let lastSeq = 0
      const events = await readSse(runId, jar, {
        timeoutMs: 15_000,
        onEvent: async (e) => {
          if (typeof e.seq === 'number') lastSeq = e.seq
          if (e.type === 'step' && e.data?.key === 'generate' && e.data?.status === 'running' && !stopped) {
            stopped = true
            await http(jar, 'POST', `/api/runs/${runId}/stop`)
          }
        },
        until: (e) => e.type === 'done',
      })
      eq(events.find((e) => e.type === 'done')?.data?.status, 'stopped', '停止瞬间终态')
      // 等待被中止的生成流程收尾，再回放确认最终状态
      await new Promise((r) => setTimeout(r, 5000))
      const replay = await consumeRun(runId, jar, { from: lastSeq, untilEnd: true, autoProbe: false, timeoutMs: 8000 })
      const snapshot = replay.find((e) => e.type === 'snapshot')?.data?.run
      const finalDone = [...replay].reverse().find((e) => e.type === 'done')
      eq(snapshot?.status, 'stopped', `最终 run.status=${snapshot?.status}（done=${finalDone?.data?.status}）`)
      const project = (await http(jar, 'GET', `/api/projects/${created.json.projectId}`)).json.project
      eq(project.versions.length, 0, '停止后仍生成了版本')
      return '停止终态 stopped，未产生版本'
    },
  )

  await runCase(
    {
      id: 'EX08',
      title: 'SSE 断开后按 seq 重连：补发遗漏事件并正常完成',
      priority: 'P1',
      req: 'A2/R6',
      expected: '重连后收到 candidates/report/done，版本正常生成',
    },
    async () => {
      const jar = new Jar()
      const created = await http(jar, 'POST', '/api/projects', { prompt: 'SLOWCREATE 做一个习惯打卡应用' })
      const runId = String(created.json.runId)
      const first = await readSse(runId, jar, {
        timeoutMs: 10_000,
        until: (e) => e.type === 'step' && e.data?.key === 'plan' && e.data?.status === 'done',
      })
      const lastSeq = Math.max(...first.filter((e) => typeof e.seq === 'number').map((e) => e.seq))
      const rest = await consumeRun(runId, jar, { from: lastSeq, timeoutMs: 20_000 })
      ok(rest.some((e) => e.type === 'candidates'), '重连后未收到 candidates')
      eq([...rest].reverse().find((e) => e.type === 'done')?.data?.status, 'done', '重连后终态')
      const project = (await http(jar, 'GET', `/api/projects/${created.json.projectId}`)).json.project
      eq(project.versions.length, 1, '重连后未生成版本')
      return `从 seq=${lastSeq} 重连，补发 ${rest.length} 个事件并完成`
    },
  )

  await runCase(
    {
      id: 'EX09',
      title: '浏览器探针超时未回报：按 0 分收尾，版本仍保存并标记需修复',
      priority: 'P1',
      req: 'A2/A6',
      expected: 'done；不挂起；score=10（静态满分）；conclusion=needs-fix',
    },
    async () => {
      const jar = new Jar()
      const created = await http(jar, 'POST', '/api/projects', { prompt: '探针超时测试：做一个任务看板' })
      const events = await consumeRun(String(created.json.runId), jar, { autoProbe: false, timeoutMs: 20_000 })
      eq(events.find((e) => e.type === 'done')?.data?.status, 'done', '终态')
      const conclusion = events.find((e) => e.type === 'conclusion')?.data
      eq(conclusion?.status, 'needs-fix', '结论')
      eq(conclusion?.score, 10, '超时后分数')
      const project = (await http(jar, 'GET', `/api/projects/${created.json.projectId}`)).json.project
      eq(project.versions.length, 1, '版本未保存')
      return `7s 未回报后 10 分收尾，版本已保存，结论 needs-fix`
    },
  )

  await runCase(
    {
      id: 'EX10',
      title: '验收模型不可用：回退启发式验收，不阻断交付',
      priority: 'P1',
      req: 'A6/R7',
      expected: 'report.reviewSource=heuristic；版本分数 100 且正常保存',
    },
    async () => {
      const jar = new Jar()
      const created = await http(jar, 'POST', '/api/projects', { prompt: 'REVIEWFAIL 做一个任务看板' })
      const events = await consumeRun(String(created.json.runId), jar, { timeoutMs: 20_000 })
      const report = events.find((e) => e.type === 'report')?.data
      eq(report?.reviewSource, 'heuristic', '验收来源')
      eq(report?.score, 100, '总分')
      const project = (await http(jar, 'GET', `/api/projects/${created.json.projectId}`)).json.project
      eq(project.versions.length, 1, '版本数')
      return '验收回退启发式，仍得 100 分并交付'
    },
  )

  const ctx = {
    slug: shareSlug,
    projectId: retryProjectId,
    cookie: retryCookie,
    versions: 1,
    generatedAt: new Date().toISOString(),
  }
  fs.mkdirSync(path.resolve(process.cwd(), 'test/results'), { recursive: true })
  fs.writeFileSync(path.resolve(process.cwd(), 'test/results/resilience-context.json'), JSON.stringify(ctx, null, 2))
  const summary = writeResults('resilience')
  if (summary.fail > 0) process.exitCode = 1
}

void main()
