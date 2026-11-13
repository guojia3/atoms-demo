// QA 接口 / 安全 / 并发自动化：针对隔离 Mock 实例（默认 3200），不触碰 3100 数据
// 用法：QA_BASE=http://127.0.0.1:3200 npx tsx test/api-qa.ts
import fs from 'node:fs'
import path from 'node:path'
import { BASE, FULL_METRICS, Jar, consumeRun, eq, http, ok, runCase, waitFor, writeResults } from './qa-harness.js'

const ts = Date.now().toString(36)
const PASSWORD = 'QaPass1234'

interface Flow {
  projectId: string
  runId: string
  v1Id: string
  v1Html: string
  v2Id: string
  v3Id: string
  candidates: string[]
  lastSeq: number
}
let flow: Flow | null = null
const flowOf = (): Flow => {
  if (!flow) throw new Error('主流程前置失败：项目未创建')
  return flow
}

async function main(): Promise<void> {
  console.log(`[api] base = ${BASE}`)
  const owner = new Jar()
  const bob = new Jar()
  const far = new Jar()

  /* ---------------- 基础 ---------------- */
  await runCase(
    {
      id: 'API01',
      title: '健康检查返回 ok/db/mock 与探针配置',
      priority: 'P0',
      req: 'R8/H1',
      expected: '200，ok=true，db=ok，mock=true，probeTimeoutSec=2',
    },
    async () => {
      const r = await http(null, 'GET', '/api/health')
      eq(r.status, 200, 'HTTP 状态')
      ok(r.json?.ok === true && r.json?.db === 'ok', '健康字段不满足')
      ok(r.json?.mock === true, 'E2 应为 mock 模式')
      eq(r.json?.probeTimeoutSec, 2, '探针超时')
      return `ok=true db=${r.json.db} mock=${r.json.mock} timeout=${r.json.probeTimeoutSec}s`
    },
  )

  await runCase(
    {
      id: 'API02',
      title: '运行配置不向前端泄露密钥',
      priority: 'P0',
      req: 'H3/R10',
      expected: '/api/config 与 /api/health 响应中不含 apiKey 字段或密钥值',
    },
    async () => {
      const cfg = await http(null, 'GET', '/api/config')
      const health = await http(null, 'GET', '/api/health')
      const text = cfg.text + health.text
      ok(!/apiKey/i.test(text), '响应中出现 apiKey 字段')
      ok(!/sk-[A-Za-z0-9]{8,}/.test(text), '响应中出现疑似密钥')
      return `config=${cfg.status} health=${health.status}，无 apiKey / 密钥串`
    },
  )

  await runCase(
    {
      id: 'API03',
      title: '未知 API 返回 404 JSON',
      priority: 'P1',
      req: 'R6',
      expected: '404 {"error":"接口不存在"}',
    },
    async () => {
      const r = await http(null, 'GET', '/api/not-exist-qa')
      eq(r.status, 404, 'HTTP 状态')
      eq(r.json?.error, '接口不存在', '错误信息')
      return '404 + 统一 JSON 错误'
    },
  )

  await runCase(
    {
      id: 'API04',
      title: '游客透明创建：/api/me 返回 guest 并下发会话 Cookie',
      priority: 'P0',
      req: 'R9/H5/A2',
      expected: 'guest=true，Set-Cookie 含 atoms_sid、HttpOnly、SameSite=Lax、Path=/',
    },
    async () => {
      const r = await http(owner, 'GET', '/api/me')
      eq(r.status, 200, 'HTTP 状态')
      ok(r.json?.guest === true, '首次访问应为游客')
      const sc = r.headers.get('set-cookie') || ''
      ok(/atoms_sid=/.test(sc), '未下发 atoms_sid')
      ok(/HttpOnly/i.test(sc), 'Cookie 缺少 HttpOnly')
      ok(/SameSite=Lax/i.test(sc), 'Cookie 缺少 SameSite=Lax')
      ok(/Path=\//.test(sc), 'Cookie 缺少 Path=/')
      return `guest=true，sid 已下发，HttpOnly + SameSite=Lax`
    },
  )

  /* ---------------- 输入校验 ---------------- */
  await runCase(
    {
      id: 'API05',
      title: '需求少于 4 字被拒绝',
      priority: 'P1',
      req: 'F1',
      expected: '400 请至少输入 4 个字',
    },
    async () => {
      const r = await http(owner, 'POST', '/api/projects', { prompt: '三个字' })
      eq(r.status, 400, 'HTTP 状态')
      ok(String(r.json?.error).includes('4 个字'), '错误文案')
      return `400 ${r.json.error}`
    },
  )

  await runCase(
    {
      id: 'API06',
      title: '需求超过 400 字被拒绝',
      priority: 'P1',
      req: 'F1/T8',
      expected: '400 需求描述最多 400 字',
    },
    async () => {
      const r = await http(owner, 'POST', '/api/projects', { prompt: 'a'.repeat(401) })
      eq(r.status, 400, 'HTTP 状态')
      ok(String(r.json?.error).includes('400'), '错误文案')
      return `400 ${r.json.error}`
    },
  )

  await runCase(
    {
      id: 'API07',
      title: '需求 400 字边界被接受',
      priority: 'P1',
      req: 'F1/T8',
      expected: '201 返回 projectId/runId',
    },
    async () => {
      const r = await http(owner, 'POST', '/api/projects', { prompt: 'a'.repeat(400) })
      eq(r.status, 201, 'HTTP 状态')
      ok(r.json?.projectId && r.json?.runId, '缺少 projectId/runId')
      return `201 边界通过（project=${String(r.json.projectId).slice(0, 8)}…）`
    },
  )

  await runCase(
    {
      id: 'API08',
      title: '非字符串需求被拒绝',
      priority: 'P1',
      req: 'F1',
      expected: '400 而不是 500',
    },
    async () => {
      const r = await http(owner, 'POST', '/api/projects', { prompt: 12345 })
      eq(r.status, 400, 'HTTP 状态')
      return `400 ${r.json?.error}`
    },
  )

  await runCase(
    {
      id: 'API09',
      title: '空请求体被拒绝',
      priority: 'P2',
      req: 'F1',
      expected: '400 而不是 500',
    },
    async () => {
      const r = await http(owner, 'POST', '/api/projects', {})
      eq(r.status, 400, 'HTTP 状态')
      return `400 ${r.json?.error}`
    },
  )

  /* ---------------- 主流程：创建 + SSE + 版本 ---------------- */
  await runCase(
    {
      id: 'API10',
      title: '游客创建项目，SSE 按快照→步骤→候选→报告→版本→完成顺序推进',
      priority: 'P0',
      req: 'R2/R6/A2',
      expected: '201；事件含 snapshot/step/candidates/report/version/conclusion/done，seq 递增，终态 done',
    },
    async () => {
      const prompt = '做一个任务看板，支持添加任务、推进状态，刷新后数据还在'
      const r = await http(owner, 'POST', '/api/projects', { prompt })
      eq(r.status, 201, '创建状态')
      const projectId = String(r.json.projectId)
      const runId = String(r.json.runId)
      const events = await consumeRun(runId, owner)
      const types = events.map((e) => e.type)
      ok(types[0] === 'snapshot', `首个事件应为 snapshot，实际 ${types[0]}`)
      for (const t of ['step', 'candidates', 'report', 'version', 'conclusion', 'done']) {
        ok(types.includes(t), `缺少事件 ${t}：${types.join(',')}`)
      }
      const seqEvents = events.filter((e) => typeof e.seq === 'number')
      for (let i = 1; i < seqEvents.length; i++) {
        ok(seqEvents[i].seq > seqEvents[i - 1].seq, 'seq 未严格递增')
      }
      const done = events.find((e) => e.type === 'done')
      eq(done?.data?.status, 'done', '终态')
      flow = {
        projectId,
        runId,
        v1Id: String(events.find((e) => e.type === 'version')?.data?.versionId || ''),
        v1Html: '',
        v2Id: '',
        v3Id: '',
        candidates: (events.find((e) => e.type === 'candidates')?.data?.candidates || []).map((c: any) => String(c.id)),
        lastSeq: events[events.length - 1].seq,
      }
      return `事件 ${events.length} 个，顺序 ${types.join(' > ')}`
    },
  )

  await runCase(
    {
      id: 'API11',
      title: '双路赛马：两个候选、模型可区分、静态分满分、报告仅采用一个',
      priority: 'P0',
      req: 'R7/A2',
      expected: 'candidates=2 且 variant 为 0/1；staticScore=10；race 中 adopted 恰好 1 个',
    },
    async () => {
      const f = flowOf()
      const events = await consumeRun(f.runId, owner, { from: 0, autoProbe: false })
      const cand = events.find((e) => e.type === 'candidates')?.data?.candidates || []
      eq(cand.length, 2, '候选数量')
      const variants = cand.map((c: any) => c.variant).sort()
      eq(variants.join(','), '0,1', '候选 variant')
      const models = cand.map((c: any) => c.model)
      ok(cand.every((c: any) => c.staticScore === 10), '静态检查未满分')
      const report = events.find((e) => e.type === 'report')?.data
      eq(report?.race?.length, 2, '赛马条目数')
      eq(report?.race?.filter((x: any) => x.adopted).length, 1, '采用数量')
      return `2 候选（variant 0/1，model ${models.join(' / ')}），静态 10 分，采用 ${report.race.find((x: any) => x.adopted)?.label}`
    },
  )

  await runCase(
    {
      id: 'API12',
      title: '候选实测数据回填幂等：重复上报不再被接受',
      priority: 'P1',
      req: 'R4/A3',
      expected: '首次 accepted=true（消费流时已回填），重复上报 accepted=false',
    },
    async () => {
      const f = flowOf()
      ok(f.candidates[0], '没有候选 ID')
      const dup = await http(owner, 'POST', `/api/candidates/${f.candidates[0]}/report`, { metrics: FULL_METRICS })
      eq(dup.status, 200, 'HTTP 状态')
      eq(dup.json?.accepted, false, '重复上报应被忽略')
      return '重复上报 accepted=false'
    },
  )

  await runCase(
    {
      id: 'API13',
      title: 'v1 落库：满分 100、版本与消息齐全、HTML 可读取',
      priority: 'P0',
      req: 'R5/A4/A5',
      expected: 'current v1；versions=1；score=100；消息含 plan/report/version/conclusion；html>2KB',
    },
    async () => {
      const f = flowOf()
      const r = await http(owner, 'GET', `/api/projects/${f.projectId}`)
      eq(r.status, 200, '项目详情状态')
      const p = r.json.project
      eq(p.versions.length, 1, '版本数')
      eq(p.versions[0].seq, 1, '版本序号')
      eq(p.versions[0].score, 100, 'v1 分数')
      const kinds = new Set(p.messages.map((m: any) => m.kind))
      for (const k of ['plan', 'report', 'version', 'conclusion']) ok(kinds.has(k), `缺少消息类型 ${k}`)
      ok(p.html.length > 2000, `HTML 过短：${p.html.length}`)
      f.v1Html = p.html
      f.v1Id = p.currentVersionId
      return `v1=100 分，html ${Math.round(p.html.length / 1024)}KB，消息 ${p.messages.length} 条`
    },
  )

  await runCase(
    {
      id: 'API14',
      title: '已完成任务断线回放：snapshot + 历史事件 + done(replayed)',
      priority: 'P1',
      req: 'R6/A2',
      expected: '回放返回 snapshot，最后 done 标记 replayed=true，不挂起',
    },
    async () => {
      const f = flowOf()
      const events = await consumeRun(f.runId, owner, { from: 0, autoProbe: false, timeoutMs: 8000, untilEnd: true })
      ok(events[0]?.type === 'snapshot', '首个事件不是 snapshot')
      const done = [...events].reverse().find((e) => e.type === 'done')
      eq(done?.data?.replayed, true, '回放标记')
      return `回放 ${events.length} 个事件，done.replayed=true`
    },
  )

  await runCase(
    {
      id: 'API15',
      title: '项目详情字段完整、无活跃任务',
      priority: 'P1',
      req: 'R6',
      expected: 'prompt/checklist/versions/shareSlug/activeRunId=null 均正确',
    },
    async () => {
      const f = flowOf()
      const r = await http(owner, 'GET', `/api/projects/${f.projectId}`)
      const p = r.json.project
      eq(p.id, f.projectId, '项目 ID')
      ok(p.prompt.length > 10, 'prompt 缺失')
      eq(p.checklist.length, 6, '验收清单条数')
      eq(p.activeRunId, null, '不应有活跃任务')
      eq(p.shareSlug, null, '未发布不应有 slug')
      return `清单 ${p.checklist.length} 条，activeRunId=null，shareSlug=null`
    },
  )

  /* ---------------- 编辑 / 版本 ---------------- */
  await runCase(
    {
      id: 'API16',
      title: '编辑生成 v2：不覆盖 v1，HTML 带修改标记',
      priority: 'P0',
      req: 'A5/H7',
      expected: '201；versions=2；v2 source=mock；当前 HTML 含 atoms-edit-banner',
    },
    async () => {
      const f = flowOf()
      const r = await http(owner, 'POST', `/api/projects/${f.projectId}/messages`, { content: '把标题改成蓝色' })
      eq(r.status, 201, '编辑状态')
      const events = await consumeRun(String(r.json.runId), owner)
      ok(events.some((e) => e.type === 'done' && e.data.status === 'done'), '编辑未完成')
      const p = (await http(owner, 'GET', `/api/projects/${f.projectId}`)).json.project
      eq(p.versions.length, 2, '版本数')
      const current = p.versions.find((v: any) => v.id === p.currentVersionId)
      eq(current?.seq, 2, '新版序号')
      ok(p.html.includes('atoms-edit-banner'), 'v2 未包含修改标记')
      ok(f.v1Id !== p.currentVersionId, '当前版本未切换')
      f.v2Id = p.currentVersionId
      return `v2 已生成（source=${current?.source}），v1 保留可查`
    },
  )

  await runCase(
    {
      id: 'API17',
      title: '版本 HTML 接口可按版本读取，越权访问 404',
      priority: 'P1',
      req: 'A5',
      expected: 'owner 读取 v1 返回原 HTML；他人读取返回 404',
    },
    async () => {
      const f = flowOf()
      const r = await http(owner, 'GET', `/api/projects/${f.projectId}/versions/${f.v1Id}/html`)
      eq(r.status, 200, 'owner 读取状态')
      eq(r.json?.html, f.v1Html, 'v1 HTML 不一致')
      const other = await http(bob, 'GET', `/api/projects/${f.projectId}/versions/${f.v1Id}/html`)
      eq(other.status, 404, '越权读取状态')
      return `owner 200（${r.json.seq}），他人 404`
    },
  )

  await runCase(
    {
      id: 'API18',
      title: '版本回退生成新版本 v3（restore），旧版 HTML 一致',
      priority: 'P0',
      req: 'A5/H7',
      expected: '恢复 v1 → v3，source=restore，当前 HTML 等于 v1',
    },
    async () => {
      const f = flowOf()
      const r = await http(owner, 'POST', `/api/projects/${f.projectId}/versions/${f.v1Id}/restore`)
      eq(r.status, 200, '回退状态')
      eq(r.json.version.seq, 3, '回退后版本序号')
      const p = (await http(owner, 'GET', `/api/projects/${f.projectId}`)).json.project
      eq(p.currentVersionId, r.json.version.id, '当前版本')
      eq(p.html, f.v1Html, '恢复后的 HTML 与 v1 不一致')
      eq(p.versions.length, 3, '版本数')
      eq(p.versions.find((v: any) => v.id === p.currentVersionId)?.source, 'restore', '版本来源')
      f.v3Id = p.currentVersionId
      return `v1 → v3（restore），HTML 与 v1 完全一致`
    },
  )

  await runCase(
    {
      id: 'API19',
      title: '项目标题更新：正常/空值/超长截断',
      priority: 'P1',
      req: 'R6',
      expected: '正常 200；空标题 400；50 字标题截断为 40 字',
    },
    async () => {
      const f = flowOf()
      const okRes = await http(owner, 'PATCH', `/api/projects/${f.projectId}`, { title: 'QA 主流程项目' })
      eq(okRes.status, 200, '正常更新')
      const empty = await http(owner, 'PATCH', `/api/projects/${f.projectId}`, { title: '   ' })
      eq(empty.status, 400, '空标题')
      const long = await http(owner, 'PATCH', `/api/projects/${f.projectId}`, { title: 'x'.repeat(50) })
      eq(long.json?.title?.length, 40, '长标题截断')
      return 'title 更新、空值拒绝、50→40 截断'
    },
  )

  await runCase(
    {
      id: 'API20',
      title: '项目列表按用户隔离',
      priority: 'P0',
      req: 'A9/R5',
      expected: 'owner 列表含主流程项目；无关游客列表为空',
    },
    async () => {
      const f = flowOf()
      const mine = await http(owner, 'GET', '/api/projects')
      ok(mine.json.projects.some((p: any) => p.id === f.projectId), 'owner 列表缺少项目')
      const other = await http(far, 'GET', '/api/projects')
      eq(other.json.projects.length, 0, '无关游客不应看到任何项目')
      return `owner ${mine.json.projects.length} 个，无关游客 0 个`
    },
  )

  /* ---------------- 发布 / 分享 ---------------- */
  await runCase(
    {
      id: 'API21',
      title: '发布生成 7 位 slug，分享接口返回当前版本',
      priority: 'P0',
      req: 'A7/R8',
      expected: 'publish 200；slug 合法；share 200 且 html/seq 与发布版本一致',
    },
    async () => {
      const f = flowOf()
      const pub = await http(owner, 'POST', `/api/projects/${f.projectId}/publish`)
      eq(pub.status, 200, '发布状态')
      ok(/^[a-z0-9]{7}$/.test(pub.json.slug), `slug 非法：${pub.json.slug}`)
      eq(pub.json.path, `/s/${pub.json.slug}`, '路径')
      eq(pub.json.publishedVersionSeq, 3, '发布版本序号')
      ;(globalThis as any).__qaSlug = pub.json.slug
      const visitor = new Jar()
      ;(globalThis as any).__qaVisitor = visitor
      const share = await http(visitor, 'GET', `/api/share/${pub.json.slug}`)
      eq(share.status, 200, '分享状态')
      ok(share.json.html.length > 2000, '分享 HTML 过短')
      eq(share.json.seq, 3, '分享版本序号')
      return `/s/${pub.json.slug}，seq=3，访客 Cookie 已下发`
    },
  )

  await runCase(
    {
      id: 'API38',
      title: '分享页模型/内置示例标记：回退后的模板版本仍应标记为内置示例',
      priority: 'P2',
      req: 'A7/R7',
      expected: 'share.mock=true（HTML 为内置模板）；当前返回 false，前端会显示「模型生成」',
      defect: 'DEF-07',
      severity: 'S4',
    },
    async () => {
      const slug = (globalThis as any).__qaSlug
      const share = await http(null, 'GET', `/api/share/${slug}`)
      eq(share.status, 200, '分享状态')
      // 当前版本是 v3 restore（内容来自 mock 模板），分享标记不应声称模型生成
      eq(share.json.mock, true, '模板内容被标记为模型生成')
      return 'mock=true'
    },
  )

  await runCase(
    {
      id: 'API23',
      title: '分享页访客数据按 visitor 隔离，不影响所有者',
      priority: 'P0',
      req: 'A7',
      expected: '访客 1 写入后仅自己可见；访客 2 为空；owner KV 不受影响',
    },
    async () => {
      const slug = (globalThis as any).__qaSlug
      const v1 = (globalThis as any).__qaVisitor as Jar
      ok(slug, '缺少发布 slug')
      const set = await http(v1, 'POST', `/api/share/${slug}/kv`, { ops: [{ op: 'set', key: 'note', value: 'visitor1' }] })
      eq(set.status, 200, '访客写入')
      const read1 = await http(v1, 'GET', `/api/share/${slug}/kv`)
      eq(read1.json.data.note, 'visitor1', '访客 1 读取')
      const v2 = new Jar()
      const read2 = await http(v2, 'GET', `/api/share/${slug}/kv`)
      eq(read2.json.data.note, undefined, '访客 2 不应读到访客 1 数据')
      const f = flowOf()
      const ownerKv = await http(owner, 'GET', `/api/projects/${f.projectId}/kv`)
      eq(ownerKv.json.data.note, undefined, 'owner 作用域被访客数据污染')
      return '访客 1 可见、访客 2 为空、owner 不受影响'
    },
  )

  await runCase(
    {
      id: 'API24',
      title: '分享 KV 缺少访客标识时拒绝写入',
      priority: 'P1',
      req: 'A7',
      expected: '400 缺少访客标识',
    },
    async () => {
      const slug = (globalThis as any).__qaSlug
      const r = await http(null, 'POST', `/api/share/${slug}/kv`, { ops: [{ op: 'set', key: 'x', value: 'y' }] })
      eq(r.status, 400, 'HTTP 状态')
      ok(String(r.json?.error).includes('访客标识'), '错误文案')
      return `400 ${r.json.error}`
    },
  )

  await runCase(
    {
      id: 'API22',
      title: '下线后分享 404，重新发布复用同一 slug',
      priority: 'P1',
      req: 'A7',
      expected: '下线 200 → share 404；再发布保存同一 slug',
    },
    async () => {
      const f = flowOf()
      const slug = (globalThis as any).__qaSlug
      const off = await http(owner, 'POST', `/api/projects/${f.projectId}/unpublish`)
      eq(off.status, 200, '下线状态')
      const gone = await http(null, 'GET', `/api/share/${slug}`)
      eq(gone.status, 404, '下线后分享状态')
      const again = await http(owner, 'POST', `/api/projects/${f.projectId}/publish`)
      eq(again.json.slug, slug, '重新发布 slug 不稳定')
      return `下线后 404，重新发布仍为 /s/${slug}`
    },
  )

  await runCase(
    {
      id: 'API25',
      title: '非法 slug（路径穿越 / SQL / 超长）返回 404 且不 500',
      priority: 'P1',
      req: 'A7',
      expected: '三种非法 slug 均 404 JSON',
    },
    async () => {
      const cases = ['..%2F..%2Fetc%2Fpasswd', '%27%20OR%201%3D1--', 'a'.repeat(200)]
      for (const s of cases) {
        const r = await http(null, 'GET', `/api/share/${s}`)
        eq(r.status, 404, `slug=${s.slice(0, 20)} 状态`)
      }
      return '路径穿越/SQL/超长 slug 均 404'
    },
  )

  /* ---------------- 所有者 KV ---------------- */
  await runCase(
    {
      id: 'API26',
      title: '所有者 KV 基本操作：set/get/del/clear 与空操作',
      priority: 'P0',
      req: 'A4/R5',
      expected: '写入可读、删除生效、清空生效、空 ops applied=0',
    },
    async () => {
      const f = flowOf()
      await http(owner, 'POST', `/api/projects/${f.projectId}/kv`, { ops: [{ op: 'clear' }] })
      await http(owner, 'POST', `/api/projects/${f.projectId}/kv`, { ops: [{ op: 'set', key: 'k1', value: 'v1' }] })
      const get = await http(owner, 'GET', `/api/projects/${f.projectId}/kv`)
      eq(get.json.data.k1, 'v1', '写入后读取')
      await http(owner, 'POST', `/api/projects/${f.projectId}/kv`, { ops: [{ op: 'del', key: 'k1' }] })
      const afterDel = await http(owner, 'GET', `/api/projects/${f.projectId}/kv`)
      eq(afterDel.json.data.k1, undefined, '删除后仍存在')
      await http(owner, 'POST', `/api/projects/${f.projectId}/kv`, { ops: [{ op: 'set', key: 'k2', value: 'v2' }] })
      await http(owner, 'POST', `/api/projects/${f.projectId}/kv`, { ops: [{ op: 'clear' }] })
      const afterClear = await http(owner, 'GET', `/api/projects/${f.projectId}/kv`)
      eq(Object.keys(afterClear.json.data).length, 0, '清空后仍有键')
      const empty = await http(owner, 'POST', `/api/projects/${f.projectId}/kv`, { ops: [] })
      eq(empty.json.applied, 0, '空操作')
      return 'set/get/del/clear 全部生效，空 ops applied=0'
    },
  )

  await runCase(
    {
      id: 'API27',
      title: 'KV 边界：键 201 字、值 200KB+1、作用域 201 键、未知操作均拒绝',
      priority: 'P1',
      req: 'R5/T8',
      expected: '四种非法输入均 400；200 字键与 200KB 值可通过',
    },
    async () => {
      const f = flowOf()
      const url = `/api/projects/${f.projectId}/kv`
      const key201 = await http(owner, 'POST', url, { ops: [{ op: 'set', key: 'k'.repeat(201), value: 'v' }] })
      eq(key201.status, 400, '201 字键')
      const value = await http(owner, 'POST', url, { ops: [{ op: 'set', key: 'big', value: 'v'.repeat(200 * 1024 + 1) }] })
      eq(value.status, 400, '超 200KB 值')
      const ops = Array.from({ length: 201 }, (_, i) => ({ op: 'set', key: `bulk-${i}`, value: 'x' }))
      const many = await http(owner, 'POST', url, { ops })
      eq(many.status, 400, '201 键')
      ok(String(many.json?.error).includes('200'), '错误文案')
      const unknown = await http(owner, 'POST', url, { ops: [{ op: 'unknown', key: 'x', value: 'y' }] })
      eq(unknown.status, 400, '未知操作')
      const boundaryKey = await http(owner, 'POST', url, { ops: [{ op: 'set', key: 'k'.repeat(200), value: 'ok' }] })
      eq(boundaryKey.status, 200, '200 字键应通过')
      const boundaryValue = await http(owner, 'POST', url, { ops: [{ op: 'set', key: 'edge', value: 'v'.repeat(200 * 1024) }] })
      eq(boundaryValue.status, 200, '200KB 值应通过')
      await http(owner, 'POST', url, { ops: [{ op: 'clear' }] })
      return '非法 4 类均 400；200 字/200KB 边界通过'
    },
  )

  /* ---------------- 账号 ---------------- */
  const upgradeEmail = `qa-upgrade-${ts}@example.com`
  await runCase(
    {
      id: 'API28',
      title: '注册参数校验：非法邮箱、短密码、超长密码',
      priority: 'P0',
      req: 'A9/H5',
      expected: '三种输入均 400，且不创建账号',
    },
    async () => {
      const jar = new Jar()
      const mail = await http(jar, 'POST', '/api/auth/register', { email: 'not-an-email', password: PASSWORD })
      eq(mail.status, 400, '非法邮箱')
      const short = await http(new Jar(), 'POST', '/api/auth/register', { email: `qa-short-${ts}@example.com`, password: '1234567' })
      eq(short.status, 400, '短密码')
      const long = await http(new Jar(), 'POST', '/api/auth/register', { email: `qa-long-${ts}@example.com`, password: 'p'.repeat(73) })
      eq(long.status, 400, '超长密码')
      return `邮箱/短密码/超长密码均 400`
    },
  )

  await runCase(
    {
      id: 'API29',
      title: '游客升级邮箱账号：项目保留，登出后跨会话登录可见',
      priority: 'P0',
      req: 'A9/H5',
      expected: 'register upgraded=true；项目仍可见；logout；新会话 login 后项目仍可见',
    },
    async () => {
      const up = new Jar()
      const me0 = await http(up, 'GET', '/api/me')
      eq(me0.json.guest, true, '升级前应为游客')
      const proj = await http(up, 'POST', '/api/projects', { prompt: '做一个习惯打卡应用，支持每日打卡与连续天数' })
      eq(proj.status, 201, '升级前创建项目')
      await consumeRun(String(proj.json.runId), up)
      const reg = await http(up, 'POST', '/api/auth/register', { email: upgradeEmail, password: PASSWORD, name: 'QA升级' })
      eq(reg.status, 200, '注册状态')
      eq(reg.json.upgraded, true, '应为升级而非新建')
      eq(reg.json.user.email, upgradeEmail, '邮箱')
      const list1 = await http(up, 'GET', '/api/projects')
      ok(list1.json.projects.some((p: any) => p.id === proj.json.projectId), '升级后项目丢失')
      const logout = await http(up, 'POST', '/api/auth/logout')
      eq(logout.status, 200, '退出状态')
      const fresh = new Jar()
      const login = await http(fresh, 'POST', '/api/auth/login', { email: upgradeEmail, password: PASSWORD })
      eq(login.status, 200, '登录状态')
      eq(login.json.user.email, upgradeEmail, '登录邮箱')
      const list2 = await http(fresh, 'GET', '/api/projects')
      ok(list2.json.projects.some((p: any) => p.id === proj.json.projectId), '跨会话项目不可见')
      ;(globalThis as any).__qaUpgradeJar = fresh
      return `游客升级成功，logout/login 后项目仍可见（${list2.json.projects.length} 个）`
    },
  )

  await runCase(
    {
      id: 'API30',
      title: '重复邮箱注册 409，错误密码/不存在邮箱登录 401 且文案一致',
      priority: 'P0',
      req: 'H5',
      expected: '409 已注册；两种登录失败均为 401 同一文案',
    },
    async () => {
      const dup = await http(new Jar(), 'POST', '/api/auth/register', { email: upgradeEmail, password: PASSWORD })
      eq(dup.status, 409, '重复邮箱')
      ok(String(dup.json?.error).includes('已注册'), '重复邮箱文案')
      const wrongPwd = await http(new Jar(), 'POST', '/api/auth/login', { email: upgradeEmail, password: 'WrongPass123' })
      eq(wrongPwd.status, 401, '错误密码')
      const noUser = await http(new Jar(), 'POST', '/api/auth/login', { email: `qa-none-${ts}@example.com`, password: PASSWORD })
      eq(noUser.status, 401, '不存在邮箱')
      eq(wrongPwd.json.error, noUser.json.error, '错误文案不应泄露账号是否存在')
      return `409 重复邮箱；401 统一文案「${wrongPwd.json.error}」`
    },
  )

  await runCase(
    {
      id: 'API31',
      title: '退出登录后旧会话失效，回到游客态且看不到原项目',
      priority: 'P1',
      req: 'H5',
      expected: '旧 Cookie 请求 /api/me 为 guest；项目列表为空',
    },
    async () => {
      const old = (globalThis as any).__qaUpgradeJar as Jar
      ok(old, '缺少已登录会话')
      const logout = await http(old, 'POST', '/api/auth/logout')
      eq(logout.status, 200, '退出状态')
      const me = await http(old, 'GET', '/api/me')
      eq(me.json.guest, true, '退出后仍为账号态')
      const list = await http(old, 'GET', '/api/projects')
      eq(list.json.projects.length, 0, '退出后仍能看到账号项目')
      return '退出后 guest=true，项目 0 个'
    },
  )

  await runCase(
    {
      id: 'API32',
      title: '伪造会话 token 不导致 500，按游客处理',
      priority: 'P1',
      req: 'H5',
      expected: '200 guest=true，重新下发有效会话',
    },
    async () => {
      const forged = new Jar()
      forged.cookies.set('atoms_sid', 'garbage-token-qa')
      const r = await http(forged, 'GET', '/api/me')
      eq(r.status, 200, 'HTTP 状态')
      eq(r.json.guest, true, '伪造 token 应回退游客')
      ok(/atoms_sid=/.test(r.headers.get('set-cookie') || ''), '未重新下发会话')
      return '200 guest=true，会话已重建'
    },
  )

  /* ---------------- 安全 ---------------- */
  await runCase(
    {
      id: 'SEC01',
      title: '越权访问矩阵：他人项目/版本/事件/候选/KV/发布/删除均 404',
      priority: 'P0',
      req: 'H3/A7',
      expected: '8 个越权请求全部 404，不泄露数据',
    },
    async () => {
      const f = flowOf()
      const urls: Array<[string, string]> = [
        ['GET', `/api/projects/${f.projectId}`],
        ['GET', `/api/projects/${f.projectId}/versions/${f.v1Id}/html`],
        ['GET', `/api/runs/${f.runId}/events`],
        ['GET', `/api/candidates/${f.candidates[0]}/html`],
        ['POST', `/api/candidates/${f.candidates[0]}/report`],
        ['GET', `/api/projects/${f.projectId}/kv`],
        ['POST', `/api/projects/${f.projectId}/publish`],
        ['DELETE', `/api/projects/${f.projectId}`],
      ]
      for (const [method, url] of urls) {
        const r = await http(bob, method, url, method === 'POST' ? { metrics: FULL_METRICS } : undefined)
        eq(r.status, 404, `${method} ${url}`)
      }
      return '8/8 越权请求返回 404'
    },
  )

  await runCase(
    {
      id: 'SEC02',
      title: 'XSS / SQL 注入输入被当作纯文本保存，不影响他人数据',
      priority: 'P0',
      req: 'H3',
      expected: 'XSS 需求 201 且原样保存；SQL 标题 200 且项目数不变；响应为 JSON',
    },
    async () => {
      const xss = new Jar()
      const payload = `<img src=x onerror=alert(1)> 做一个清单`
      const created = await http(xss, 'POST', '/api/projects', { prompt: payload })
      eq(created.status, 201, 'XSS 需求创建')
      const p = (await http(xss, 'GET', `/api/projects/${created.json.projectId}`)).json.project
      eq(p.prompt, payload, 'XSS 需求被改写')
      ok(/application\/json/.test((await http(xss, 'GET', `/api/projects/${created.json.projectId}`)).headers.get('content-type') || ''), '响应不是 JSON')
      const sql = `' OR 1=1--`
      const patch = await http(xss, 'PATCH', `/api/projects/${created.json.projectId}`, { title: sql })
      eq(patch.status, 200, 'SQL 标题更新')
      eq(patch.json.title, sql, 'SQL 标题被改写')
      const list = await http(xss, 'GET', '/api/projects')
      eq(list.json.projects.length, 1, '注入影响了项目隔离')
      return 'XSS/SQL 字符串原样保存，列表仍仅 1 个项目'
    },
  )

  await runCase(
    {
      id: 'SEC03',
      title: '超大请求体应返回 413',
      priority: 'P1',
      req: 'H3',
      expected: '413 Payload Too Large；当前实现返回 500',
      defect: 'DEF-02',
      severity: 'S3',
    },
    async () => {
      const r = await http(null, 'POST', '/api/projects', { prompt: 'a'.repeat(4_600_000) })
      eq(r.status, 413, '超大请求体状态')
      return `413（实际 ${r.status} ${r.json?.error || ''}）`
    },
  )

  await runCase(
    {
      id: 'SEC04',
      title: '畸形 JSON 应返回 400',
      priority: 'P1',
      req: 'H3',
      expected: '400 Bad Request；当前实现返回 500',
      defect: 'DEF-02',
      severity: 'S3',
    },
    async () => {
      const res = await fetch(`${BASE}/api/projects`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{"prompt":',
      })
      eq(res.status, 400, '畸形 JSON 状态')
      return `400（实际 ${res.status}）`
    },
  )

  await runCase(
    {
      id: 'SEC05',
      title: 'API 响应应带基础安全响应头',
      priority: 'P1',
      req: 'H3',
      expected: 'X-Content-Type-Options/X-Frame-Options/CSP/Referrer-Policy 至少存在',
      defect: 'DEF-03',
      severity: 'S3',
    },
    async () => {
      const r = await http(null, 'GET', '/api/health')
      const missing: string[] = []
      for (const h of ['x-content-type-options', 'x-frame-options', 'content-security-policy', 'referrer-policy']) {
        if (!r.headers.get(h)) missing.push(h)
      }
      ok(missing.length === 0, `缺失安全响应头：${missing.join(', ')}`)
      return '4 个基础安全响应头齐全'
    },
  )

  await runCase(
    {
      id: 'SEC06',
      title: '会话 Cookie：HTTPS 下带 Secure，HTTP 直连不加',
      priority: 'P1',
      req: 'H3/H5',
      expected: 'X-Forwarded-Proto=https 时 atoms_sid 含 Secure；HTTP 直连不加 Secure',
      defect: 'DEF-04',
      severity: 'S3',
    },
    async () => {
      const https = await http(new Jar(), 'GET', '/api/me', undefined, { 'x-forwarded-proto': 'https' })
      const secureCookie = https.headers.get('set-cookie') || ''
      ok(/;\s*Secure/i.test(secureCookie), 'HTTPS 请求 Cookie 缺少 Secure')
      ok(/HttpOnly/i.test(secureCookie) && /SameSite=Lax/i.test(secureCookie), 'HTTPS Cookie 缺少 HttpOnly/SameSite')
      const plain = await http(new Jar(), 'GET', '/api/me')
      const plainCookie = plain.headers.get('set-cookie') || ''
      ok(/atoms_sid=/.test(plainCookie), 'HTTP 直连未下发会话')
      ok(!/;\s*Secure/i.test(plainCookie), 'HTTP 直连不应加 Secure')
      return 'HTTPS=Secure+HttpOnly+SameSite；HTTP=不加 Secure'
    },
  )

  await runCase(
    {
      id: 'SEC07',
      title: '密码 scrypt 哈希、会话仅存 token 哈希',
      priority: 'P0',
      req: 'H5',
      expected: 'users.password_hash 以 scrypt$ 开头；sessions.token_hash 为 64 位 hex；无明文',
    },
    async () => {
      // @ts-ignore node:sqlite 类型由运行时提供
      const { DatabaseSync } = await import('node:sqlite')
      const dbPath = path.resolve(process.cwd(), 'data/qa-mock.db')
      if (!fs.existsSync(dbPath)) throw new Error(`数据库不存在：${dbPath}`)
      const db = new DatabaseSync(dbPath, { readOnly: true })
      try {
        const users = db.prepare('SELECT email, password_hash FROM users WHERE email IS NOT NULL').all() as any[]
        ok(users.length > 0, '没有邮箱账号')
        for (const u of users) {
          ok(String(u.password_hash).startsWith('scrypt$'), `${u.email} 密码未哈希`)
          eq(String(u.password_hash).split('$').length, 3, `${u.email} 哈希格式`)
          ok(!String(u.password_hash).includes(PASSWORD), '哈希中出现明文密码')
        }
        const sessions = db.prepare('SELECT token_hash FROM sessions').all() as any[]
        ok(sessions.length > 0, '没有会话记录')
        for (const s of sessions) ok(/^[0-9a-f]{64}$/.test(String(s.token_hash)), '会话未以哈希存储')
        const rawSid = owner.get('atoms_sid') || ''
        ok(rawSid.length > 0, '缺少原始 sid')
        ok(!sessions.some((s) => String(s.token_hash) === rawSid), '会话表存了原始 token')
        return `${users.length} 个账号 scrypt 哈希；${sessions.length} 个会话仅存 SHA-256`
      } finally {
        db.close()
      }
    },
  )

  await runCase(
    {
      id: 'SEC08',
      title: '跨站 Origin 的写请求被服务端拒绝（CSRF 面）',
      priority: 'P2',
      req: 'H3',
      expected: '跨站 Origin 返回 403，同源/无来源不受影响',
      defect: 'DEF-05',
      severity: 'S4',
    },
    async () => {
      const r = await http(owner, 'POST', '/api/projects', { prompt: 'CSRF Origin 测试项目，验证服务端是否校验来源' }, { origin: 'http://evil.example' })
      eq(r.status, 403, '跨站 Origin 状态')
      ok(/跨站/.test(r.json?.error || ''), '缺少跨站拒绝文案')
      return '跨站 Origin 403 拒绝'
    },
  )

  await runCase(
    {
      id: 'SEC09',
      title: '前端构建产物与 API 响应不含模型密钥',
      priority: 'P0',
      req: 'H3/R10',
      expected: 'dist/client 中无 sk-*、LLM_API_KEY；API 无 apiKey',
    },
    async () => {
      const dir = path.resolve(process.cwd(), 'dist/client')
      ok(fs.existsSync(dir), '缺少前端构建产物')
      let text = ''
      const walk = (d: string) => {
        for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
          const full = path.join(d, entry.name)
          if (entry.isDirectory()) walk(full)
          else if (/\.(js|html|css|json)$/i.test(entry.name)) text += fs.readFileSync(full, 'utf8')
        }
      }
      walk(dir)
      ok(!/sk-[A-Za-z0-9]{10,}/.test(text), '构建产物含疑似密钥')
      ok(!text.includes('LLM_API_KEY'), '构建产物含 LLM_API_KEY')
      ok(!text.includes('LLM_PROVIDERS'), '构建产物含供应商配置名')
      const cfg = (await http(null, 'GET', '/api/config')).text
      ok(!cfg.includes('apiKey'), 'config 泄露 apiKey')
      return `扫描 dist/client ${Math.round(text.length / 1024)}KB，无密钥/环境变量名`
    },
  )

  /* ---------------- 并发 ---------------- */
  await runCase(
    {
      id: 'CON01',
      title: '同一游客 21 个并发生成：20 个放行、超出返回 429 且带 Retry-After',
      priority: 'P1',
      req: 'H3/设计规格 5.3',
      expected: '默认配额 20/小时；21 并发中 201 ≤20、至少 1 个 429，且 429 带 Retry-After',
      defect: 'DEF-01',
      severity: 'S3',
    },
    async () => {
      const jar = new Jar()
      await http(jar, 'GET', '/api/me')
      const results = await Promise.all(
        Array.from({ length: 21 }, (_, i) =>
          http(jar, 'POST', '/api/projects', { prompt: `并发限流测试项目 ${i}，做一个任务看板` }),
        ),
      )
      const statuses = results.map((r) => r.status)
      const created = statuses.filter((s) => s === 201).length
      const limited = results.find((r) => r.status === 429)
      ok(created <= 20, `放行数量超过配额：${created}`)
      ok(!!limited, `无限流：${statuses.join(',')}`)
      ok(Number(limited!.headers.get('retry-after') || 0) > 0, '429 缺少 Retry-After')
      return `201=${created}，429=${statuses.filter((s) => s === 429).length}，Retry-After>0`
    },
  )

  await runCase(
    {
      id: 'CON02',
      title: '同一项目并发编辑互斥：1 个 201 + 1 个 409',
      priority: 'P1',
      req: 'H7',
      expected: '恰好一个请求启动任务，另一个被 409 拒绝',
    },
    async () => {
      const jar = new Jar()
      const created = await http(jar, 'POST', '/api/projects', { prompt: '并发编辑互斥测试：做一个任务看板' })
      eq(created.status, 201, '创建')
      await consumeRun(String(created.json.runId), jar)
      const [a, b] = await Promise.all([
        http(jar, 'POST', `/api/projects/${created.json.projectId}/messages`, { content: '把背景改成浅灰色' }),
        http(jar, 'POST', `/api/projects/${created.json.projectId}/messages`, { content: '把按钮改成圆角' }),
      ])
      const statuses = [a.status, b.status].sort()
      eq(statuses[0], 201, '应有一个成功')
      eq(statuses[1], 409, '应有一个冲突')
      return `并发编辑状态 ${statuses.join(' / ')}`
    },
  )

  await runCase(
    {
      id: 'CON03',
      title: '同一候选并发上报：恰好一个 accepted=true',
      priority: 'P1',
      req: 'R4',
      expected: '两个并发报告仅一个被接受，不重复计分',
    },
    async () => {
      const jar = new Jar()
      const created = await http(jar, 'POST', '/api/projects', { prompt: '并发上报测试项目：做一个习惯打卡应用' })
      eq(created.status, 201, '创建')
      const events = await consumeRun(String(created.json.runId), jar, { autoProbe: false, stopAt: 'candidates', timeoutMs: 15_000 })
      const candidates = events.find((e) => e.type === 'candidates')?.data?.candidates || []
      ok(candidates.length > 0, '未收到候选事件')
      const id = candidates[0].id
      const zero = { ...FULL_METRICS, elements: 0, textLength: 0, simulatedClicks: 0, simulatedChanges: 0, writes: 0, keys: 0 }
      const [a, b] = await Promise.all([
        http(jar, 'POST', `/api/candidates/${id}/report`, { metrics: FULL_METRICS }),
        http(jar, 'POST', `/api/candidates/${id}/report`, { metrics: zero }),
      ])
      const accepted = [a, b].filter((r) => r.json?.accepted === true).length
      eq(accepted, 1, '接受的报告数量')
      return `并发上报 accepted 恰好 1 个`
    },
  )

  await runCase(
    {
      id: 'CON04',
      title: 'KV 并发写：20 个键全部保留，同键并发不产生 500',
      priority: 'P1',
      req: 'A4',
      expected: '20 个键并发写入后全部存在；同键 10 并发值为其中之一',
    },
    async () => {
      const f = flowOf()
      const url = `/api/projects/${f.projectId}/kv`
      await http(owner, 'POST', url, { ops: [{ op: 'clear' }] })
      const writes = await Promise.all(
        Array.from({ length: 20 }, (_, i) => http(owner, 'POST', url, { ops: [{ op: 'set', key: `c-${i}`, value: `v-${i}` }] })),
      )
      ok(writes.every((r) => r.status === 200), '并发写入存在失败')
      const get = await http(owner, 'GET', url)
      eq(Object.keys(get.json.data).length, 20, '并发写入丢键')
      const same = await Promise.all(
        Array.from({ length: 10 }, (_, i) => http(owner, 'POST', url, { ops: [{ op: 'set', key: 'race', value: `r-${i}` }] })),
      )
      ok(same.every((r) => r.status === 200), '同键并发存在失败')
      const race = (await http(owner, 'GET', url)).json.data.race
      ok(/^r-[0-9]$/.test(race), `同键并发结果异常：${race}`)
      await http(owner, 'POST', url, { ops: [{ op: 'clear' }] })
      return `20/20 键保留；同键并发最终值 ${race}`
    },
  )

  await runCase(
    {
      id: 'CON05',
      title: '多用户并发创建与列表隔离',
      priority: 'P1',
      req: 'A9',
      expected: '3 个用户各建 1 个项目，各自列表仅见自己的项目',
    },
    async () => {
      const jars = [new Jar(), new Jar(), new Jar()]
      await Promise.all(jars.map((j) => http(j, 'GET', '/api/me')))
      const created = await Promise.all(
        jars.map((j, i) => http(j, 'POST', '/api/projects', { prompt: `多用户隔离测试 ${i}：做一个任务看板` })),
      )
      ok(created.every((r) => r.status === 201), '并发创建失败')
      const lists = await Promise.all(jars.map((j) => http(j, 'GET', '/api/projects')))
      for (let i = 0; i < jars.length; i++) {
        eq(lists[i].json.projects.length, 1, `用户 ${i} 项目数`)
        eq(lists[i].json.projects[0].id, created[i].json.projectId, `用户 ${i} 项目归属`)
      }
      const ids = new Set(created.map((r) => r.json.projectId))
      eq(ids.size, 3, '项目 ID 冲突')
      return '3 用户各 1 项目，列表与归属完全隔离'
    },
  )

  await runCase(
    {
      id: 'CON06',
      title: '并发发布幂等：5 次并发发布返回同一 slug',
      priority: 'P1',
      req: 'A7',
      expected: '5 次并发 publish 均 200 且 slug 相同，DB 仅一条项目',
    },
    async () => {
      const f = flowOf()
      const results = await Promise.all(Array.from({ length: 5 }, () => http(owner, 'POST', `/api/projects/${f.projectId}/publish`)))
      ok(results.every((r) => r.status === 200), '存在发布失败')
      const slugs = new Set(results.map((r) => r.json.slug))
      eq(slugs.size, 1, '并发发布产生了多个 slug')
      return `5/5 发布成功，slug 唯一：/s/${[...slugs][0]}`
    },
  )

  /* ---------------- 样例 / 删除 / 重试 / 限流 ---------------- */
  await runCase(
    {
      id: 'API33',
      title: '首页样例仅包含种子成品，一个品类一个入口',
      priority: 'P1',
      req: 'H2/A1',
      expected: 'samples 恰为 6 个，含 k7m2x9，不含 calculator，均有 slug 与 kind，slug 不重复',
    },
    async () => {
      const r = await http(new Jar(), 'GET', '/api/samples')
      eq(r.status, 200, 'HTTP 状态')
      const samples = r.json.samples || []
      eq(samples.length, 6, '样例数量应为 6')
      ok(samples.some((s: any) => s.slug === 'k7m2x9'), '缺少种子 k7m2x9')
      ok(!samples.some((s: any) => s.kind === 'calculator'), '计算器应从成品库移除')
      ok(samples.every((s: any) => s.slug && s.title && s.kind), '样例字段缺失')
      const slugs = new Set(samples.map((s: any) => s.slug))
      eq(slugs.size, samples.length, '样例 slug 重复')
      return `${samples.length} 个样例，slug 唯一，无 calculator`
    },
  )

  await runCase(
    {
      id: 'API34',
      title: '种子分享页可公开访问，未知 slug 返回可读错误',
      priority: 'P0',
      req: 'A1/A7',
      expected: 'share/k7m2x9 200 且有完整 HTML；share/未知 404 JSON',
    },
    async () => {
      const seed = await http(new Jar(), 'GET', '/api/share/k7m2x9')
      eq(seed.status, 200, '种子分享状态')
      ok(seed.json.html.includes('<!DOCTYPE html>'), '种子 HTML 不完整')
      const missing = await http(null, 'GET', '/api/share/qa-not-exist-000')
      eq(missing.status, 404, '未知 slug 状态')
      ok(String(missing.json?.error).includes('不存在'), '未知 slug 文案')
      return '种子 200，未知 slug 404'
    },
  )

  await runCase(
    {
      id: 'API35',
      title: '删除项目：列表移除、详情 404、分享链接失效、版本级联删除',
      priority: 'P1',
      req: 'R6',
      expected: 'delete 200；GET 404；share 404；versions 记录为 0',
    },
    async () => {
      const jar = new Jar()
      const created = await http(jar, 'POST', '/api/projects', { prompt: '删除级联测试项目：做一个任务看板' })
      eq(created.status, 201, '创建')
      await consumeRun(String(created.json.runId), jar)
      const pub = await http(jar, 'POST', `/api/projects/${created.json.projectId}/publish`)
      const del = await http(jar, 'DELETE', `/api/projects/${created.json.projectId}`)
      eq(del.status, 200, '删除状态')
      eq((await http(jar, 'GET', `/api/projects/${created.json.projectId}`)).status, 404, '详情')
      eq((await http(null, 'GET', `/api/share/${pub.json.slug}`)).status, 404, '分享')
      // @ts-ignore node:sqlite 类型由运行时提供
      const { DatabaseSync } = await import('node:sqlite')
      const db = new DatabaseSync(path.resolve(process.cwd(), 'data/qa-mock.db'), { readOnly: true })
      try {
        const row = db.prepare('SELECT COUNT(*) AS n FROM versions WHERE project_id = ?').get(created.json.projectId) as any
        eq(Number(row.n), 0, '版本未级联删除')
      } finally {
        db.close()
      }
      return '删除后详情/分享 404，版本级联为 0'
    },
  )

  await runCase(
    {
      id: 'API36',
      title: '已完成任务可重试并生成新版本',
      priority: 'P2',
      req: 'A11',
      expected: 'retry 200；重跑完成；版本数 +1',
    },
    async () => {
      const f = flowOf()
      const before = (await http(owner, 'GET', `/api/projects/${f.projectId}`)).json.project.versions.length
      const retry = await http(owner, 'POST', `/api/runs/${f.runId}/retry`)
      eq(retry.status, 200, '重试状态')
      const events = await consumeRun(f.runId, owner, { from: f.lastSeq + 1, timeoutMs: 15000 })
      ok(events.some((e) => e.type === 'done' && e.data.status === 'done'), '重试未完成')
      const after = (await http(owner, 'GET', `/api/projects/${f.projectId}`)).json.project.versions.length
      eq(after, before + 1, '重试未生成新版本')
      return `版本 ${before} → ${after}`
    },
  )

  await runCase(
    {
      id: 'API37',
      title: '登录接口限流：同一 IP 超过 20 次失败请求后返回 429',
      priority: 'P1',
      req: 'H5',
      expected: '累计第 21 次左右出现 429，其后保持 429',
    },
    async () => {
      const email = `qa-limit-${ts}@example.com`
      const statuses: number[] = []
      for (let i = 0; i < 24; i++) {
        const r = await http(null, 'POST', '/api/auth/login', { email, password: 'WrongPass123' })
        statuses.push(r.status)
      }
      const first429 = statuses.indexOf(429)
      ok(first429 !== -1, `未触发限流：${statuses.join(',')}`)
      ok(first429 <= 21, `限流触发过晚（第 ${first429 + 1} 次）`)
      ok(statuses.slice(first429).every((s) => s === 429), '触发限流后仍放行')
      return `第 ${first429 + 1} 次起 429（此前已有登录尝试计入同一 IP 窗口）`
    },
  )

  const summary = writeResults('api')
  if (summary.fail > 0) process.exitCode = 1
}

void main()
