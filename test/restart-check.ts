// 持久化/重启验证：MODE=prepare 采集基线（项目/分享页/访客 KV）；MODE=verify 重启后逐项比对
// 用法：
//   MODE=prepare QA_BASE=http://127.0.0.1:3201 npx tsx test/restart-check.ts
//   （重启实例）
//   MODE=verify  QA_BASE=http://127.0.0.1:3201 npx tsx test/restart-check.ts
import fs from 'node:fs'
import path from 'node:path'
import { Jar, http, eq, ok, runCase, writeResults } from './qa-harness.js'

const mode = process.env.MODE || 'verify'
const resultsDir = path.resolve(process.cwd(), 'test/results')
const ctxPath = path.join(resultsDir, 'resilience-context.json')
const baselinePath = path.join(resultsDir, 'persistence-baseline.json')
const ctx = JSON.parse(fs.readFileSync(ctxPath, 'utf8')) as {
  slug: string
  projectId: string
  cookie: string
}
const dbPath = path.resolve(process.cwd(), process.env.DATABASE_PATH || './data/qa-fake.db')

function ownerJar(): Jar {
  const jar = new Jar()
  for (const pair of String(ctx.cookie).split('; ')) {
    const idx = pair.indexOf('=')
    if (idx > 0) jar.cookies.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim())
  }
  return jar
}

async function prepare(): Promise<void> {
  const jar = ownerJar()
  const detail = await http(jar, 'GET', `/api/projects/${ctx.projectId}`)
  eq(detail.status, 200, '项目详情状态')
  const project = detail.json.project
  ok(project, '基线项目不存在')

  const share = await http(null, 'GET', `/api/share/${ctx.slug}`)
  eq(share.status, 200, '分享页状态')

  const visitor = new Jar()
  const shareV = await http(visitor, 'GET', `/api/share/${ctx.slug}`)
  eq(shareV.status, 200, '分享页（取访客标识）')
  const kv = await http(visitor, 'POST', `/api/share/${ctx.slug}/kv`, {
    ops: [{ op: 'set', key: 'qa-persist', value: 'before-restart' }],
  })
  eq(kv.status, 200, '访客 KV 写入')

  const baseline = {
    projectId: ctx.projectId,
    slug: ctx.slug,
    title: project.title,
    currentVersionId: project.currentVersionId,
    versions: project.versions.length,
    htmlLength: project.html.length,
    shareSeq: share.json.seq,
    shareHtmlLength: share.json.html.length,
    visitorCookie: visitor.header(),
    capturedAt: new Date().toISOString(),
  }
  fs.mkdirSync(resultsDir, { recursive: true })
  fs.writeFileSync(baselinePath, JSON.stringify(baseline, null, 2))
  console.log(`[prepare] 基线已保存：versions=${baseline.versions} html=${baseline.htmlLength} shareSeq=${baseline.shareSeq}`)
}

async function verify(): Promise<void> {
  const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'))
  const jar = ownerJar()

  await runCase(
    {
      id: 'PER01',
      title: '进程重启后：所有者项目、版本与当前版本完整保留',
      priority: 'P0',
      req: 'A4/A9/R5',
      expected: '项目可访问；版本数/currentVersionId/HTML 长度与重启前一致',
    },
    async () => {
      const detail = await http(jar, 'GET', `/api/projects/${baseline.projectId}`)
      eq(detail.status, 200, '重启后项目详情状态')
      const project = detail.json.project
      ok(project, '重启后项目丢失')
      eq(project.versions.length, baseline.versions, '版本数')
      eq(project.currentVersionId, baseline.currentVersionId, '当前版本')
      eq(project.title, baseline.title, '标题')
      eq(project.html.length, baseline.htmlLength, '当前版本 HTML 长度')
      return `v${project.versions[0].seq}/${project.versions.length} 个版本完整，HTML ${project.html.length} 字符`
    },
  )

  await runCase(
    {
      id: 'PER02',
      title: '重启后：无僵死 running 任务，历史运行记录保留',
      priority: 'P1',
      req: 'A2/A11/R6',
      expected: 'runs 表 status=running 数量为 0；总运行记录 >0',
    },
    async () => {
      const { DatabaseSync } = await import('node:sqlite')
      const db = new DatabaseSync(dbPath, { readOnly: true } as any)
      try {
        const running = db.prepare("SELECT COUNT(*) AS n FROM runs WHERE status = 'running'").get() as { n: number }
        const total = db.prepare('SELECT COUNT(*) AS n FROM runs').get() as { n: number }
        eq(running.n, 0, '重启后仍有 running 任务')
        ok(total.n > 0, '运行记录缺失')
        return `历史运行 ${total.n} 条，running=0`
      } finally {
        db.close()
      }
    },
  )

  await runCase(
    {
      id: 'PER03',
      title: '重启后：发布页可访问，固定版本与访客 KV 均保留',
      priority: 'P0',
      req: 'A7/R5',
      expected: '分享页 200；seq/HTML 与重启前一致；访客 KV qa-persist=before-restart',
    },
    async () => {
      const share = await http(null, 'GET', `/api/share/${baseline.slug}`)
      eq(share.status, 200, '重启后分享页状态')
      eq(share.json.seq, baseline.shareSeq, '发布版本序号')
      eq(share.json.html.length, baseline.shareHtmlLength, '发布版本 HTML 长度')

      const visitor = new Jar()
      for (const pair of String(baseline.visitorCookie).split('; ')) {
        const idx = pair.indexOf('=')
        if (idx > 0) visitor.cookies.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim())
      }
      const kv = await http(visitor, 'GET', `/api/share/${baseline.slug}/kv`)
      eq(kv.status, 200, '访客 KV 读取')
      eq(kv.json.data?.['qa-persist'], 'before-restart', '访客 KV 值')
      return `/s/${baseline.slug} v${share.json.seq} 可访问，访客 KV 保留`
    },
  )

  const summary = writeResults('persistence')
  if (summary.fail > 0) process.exitCode = 1
}

if (mode === 'prepare') {
  void prepare()
} else {
  void verify()
}
