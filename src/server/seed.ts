// 种子数据：3 个已发布的成品，保证访客首次打开首页不空白
import { addMessage, createProject, createVersion, findProjectBySlug, touchProject } from './store.js'
import { mockPlan } from './agents/planner.js'
import { mockHtml } from './mock/templates.js'
import { getOne, now, run } from './db.js'

const SEED_USER_ID = 'seed-owner'

const SAMPLES = [
  {
    slug: 'k7m2x9',
    kind: 'kanban' as const,
    title: '任务看板',
    prompt: '做一个任务看板，支持添加任务、在待办/进行中/已完成之间推进，刷新后数据还在',
    score: 92,
  },
  {
    slug: 'c4v8q1',
    kind: 'calculator' as const,
    title: '计算器',
    prompt: '做一个计算器，支持加减乘除和百分比，保留历史记录，刷新后还能看到',
    score: 90,
  },
  {
    slug: 'h3t6w8',
    kind: 'habit' as const,
    title: '习惯打卡',
    prompt: '做一个习惯打卡应用，可以添加习惯、按天打卡、显示连续天数，数据本地保存',
    score: 93,
  },
]

export function seedSamples(): void {
  for (const sample of SAMPLES) {
    if (findProjectBySlug(sample.slug)) continue
    if (!getOne('SELECT id FROM users WHERE id = ?', SEED_USER_ID)) {
      run(
        "INSERT INTO users (id, kind, email, name, password_hash, created_at) VALUES (?, 'guest', NULL, ?, NULL, ?)",
        SEED_USER_ID,
        '示例空间',
        now(),
      )
    }
    const project = createProject(SEED_USER_ID, sample.title, sample.prompt)
    const plan = mockPlan(sample.prompt)
    touchProject(project.id, {
      plan_json: JSON.stringify({ ...plan, title: sample.title }),
      checklist_json: JSON.stringify(plan.checklist),
    })
    addMessage({
      projectId: project.id,
      role: 'agent',
      kind: 'plan',
      content: `${sample.title}：${plan.summary}`,
      meta: { plan: { ...plan, title: sample.title } },
    })
    const html = mockHtml(sample.kind, sample.prompt)
    const version = createVersion({
      projectId: project.id,
      html,
      model: 'atoms-mock',
      source: 'mock',
      score: sample.score,
      report: {
        score: sample.score,
        parts: { static: 10, probe: 47, checklist: 35 },
        notes: ['内置示例：由 Atoms Demo 生成并发布'],
      },
    })
    addMessage({
      projectId: project.id,
      role: 'agent',
      kind: 'version',
      content: `已生成版本 v${version.seq}`,
      meta: { versionId: version.id, seq: version.seq, score: sample.score, model: 'atoms-mock', adopted: true },
    })
    addMessage({
      projectId: project.id,
      role: 'agent',
      kind: 'conclusion',
      content: `已采用 v${version.seq}（${sample.score} 分）。这是预置示例，可直接体验或复制为模板。`,
      meta: { score: sample.score, adopted: true, status: 'passed', versionSeq: version.seq, fallback: true },
    })
    touchProject(project.id, {
      current_version_id: version.id,
      published_version_id: version.id,
      share_slug: sample.slug,
    })
  }
}

const isDirectRun = process.argv[1]?.includes('seed')
if (isDirectRun) {
  seedSamples()
  console.log('[atoms] 种子数据已就绪')
}
