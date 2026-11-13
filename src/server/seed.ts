// 种子数据：6 个已发布的成品，保证访客首次打开首页不空白
// slug 已存在时会比对当前发布版本 HTML，模板更新后自动生成新版本并重新发布（幂等）
import { addMessage, createProject, createVersion, deleteProject, findProjectBySlug, getVersion, touchProject } from './store.js'
import { mockPlan } from './agents/planner.js'
import { mockHtml, type TemplateKind } from './mock/templates.js'
import { getOne, now, run } from './db.js'

const SEED_USER_ID = 'seed-owner'

interface SeedSample {
  slug: string
  kind: TemplateKind
  title: string
  prompt: string
  score: number
}

export const SEED_SAMPLES: SeedSample[] = [
  {
    slug: 'k7m2x9',
    kind: 'kanban',
    title: '任务看板',
    prompt: '做一个任务看板，支持添加任务、在待办/进行中/已完成之间推进，刷新后数据还在',
    score: 92,
  },
  {
    slug: 'h3t6w8',
    kind: 'habit',
    title: '习惯打卡',
    prompt: '做一个习惯打卡应用，可以添加习惯、按天打卡、显示连续天数，数据本地保存',
    score: 93,
  },
  {
    slug: 'g2a4m8',
    kind: 'game2048',
    title: '2048',
    prompt: '做一个 2048 游戏，方向键和手机滑动都能玩，有合并计分、胜负判定和最高分记录',
    score: 91,
  },
  {
    slug: 'p6f3k9',
    kind: 'pomodoro',
    title: '番茄专注',
    prompt: '做一个番茄钟，25 分钟专注 + 5 分钟休息，可以暂停重置，完成次数按天保存',
    score: 94,
  },
  {
    slug: 'm4n8t2',
    kind: 'notes',
    title: 'Markdown 笔记',
    prompt: '做一个 Markdown 笔记应用，支持新建、搜索、自动保存和实时预览',
    score: 92,
  },
  {
    slug: 'e5x7b3',
    kind: 'expense',
    title: '记账本',
    prompt: '做一个记账本，记录金额、分类和备注，自动汇总合计，支持筛选和删除',
    score: 90,
  },
]

// 已下线的种子成品：旧库若仍存在，启动时删除项目（版本/消息/运行/数据随外键级联清理），分享链接随之失效
const RETIRED_SAMPLE_SLUGS = ['c4v8q1']

function removeRetiredSamples(): void {
  for (const slug of RETIRED_SAMPLE_SLUGS) {
    const project = findProjectBySlug(slug)
    if (project && project.user_id === SEED_USER_ID) deleteProject(project.id)
  }
}

function ensureSeedUser(): void {
  if (getOne('SELECT id FROM users WHERE id = ?', SEED_USER_ID)) return
  run(
    "INSERT INTO users (id, kind, email, name, password_hash, created_at) VALUES (?, 'guest', NULL, ?, NULL, ?)",
    SEED_USER_ID,
    '示例空间',
    now(),
  )
}

function planFor(sample: SeedSample) {
  const plan = mockPlan(sample.prompt)
  return { ...plan, title: sample.title }
}

function publishVersion(projectId: string, sample: SeedSample, html: string, plan: ReturnType<typeof planFor>): void {
  const version = createVersion({
    projectId,
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
    projectId,
    role: 'agent',
    kind: 'version',
    content: `已生成版本 v${version.seq}`,
    meta: { versionId: version.id, seq: version.seq, score: sample.score, model: 'atoms-mock', adopted: true },
  })
  addMessage({
    projectId,
    role: 'agent',
    kind: 'conclusion',
    content: `已采用 v${version.seq}（${sample.score} 分）。这是预置示例，可直接体验或复制为模板。`,
    meta: { score: sample.score, adopted: true, status: 'passed', versionSeq: version.seq, fallback: true },
  })
  touchProject(projectId, {
    title: sample.title,
    plan_json: JSON.stringify(plan),
    checklist_json: JSON.stringify(plan.checklist),
    current_version_id: version.id,
    published_version_id: version.id,
    share_slug: sample.slug,
  })
}

export function seedSamples(): void {
  ensureSeedUser()
  removeRetiredSamples()
  for (const sample of SEED_SAMPLES) {
    const html = mockHtml(sample.kind, sample.prompt)
    const plan = planFor(sample)
    const existing = findProjectBySlug(sample.slug)
    if (existing) {
      const published = existing.published_version_id ? getVersion(existing.published_version_id) : null
      // 已是最新模板内容则跳过，避免每次启动都新增版本
      if (published && published.html === html && existing.title === sample.title) continue
      publishVersion(existing.id, sample, html, plan)
      continue
    }
    const project = createProject(SEED_USER_ID, sample.title, sample.prompt)
    touchProject(project.id, {
      plan_json: JSON.stringify(plan),
      checklist_json: JSON.stringify(plan.checklist),
    })
    addMessage({
      projectId: project.id,
      role: 'agent',
      kind: 'plan',
      content: `${sample.title}：${plan.summary}`,
      meta: { plan },
    })
    publishVersion(project.id, sample, html, plan)
  }
}

const isDirectRun = process.argv[1]?.includes('seed')
if (isDirectRun) {
  seedSamples()
  console.log('[atoms] 种子数据已就绪')
}
