// 规划师 Mike：把一句话需求拆成目标、页面、功能与可验收清单
import { isMockMode } from '../config.js'
import { streamChat } from '../llm/client.js'
import { escapeHtml, pickTemplate } from '../mock/templates.js'

export interface ChecklistItem {
  id: string
  text: string
}

export interface Plan {
  title: string
  summary: string
  views: string[]
  features: string[]
  design: string
  data: string
  checklist: ChecklistItem[]
  source: 'model' | 'mock'
  model?: string
  notes?: string
}

function cleanTitle(prompt: string): string {
  const t = prompt
    .replace(/[，。,.!！?？\n]/g, ' ')
    .trim()
    .slice(0, 20)
  return t || '未命名应用'
}

export function mockPlan(prompt: string, mode: 'create' | 'edit' = 'create'): Plan {
  const kind = pickTemplate(prompt)
  const names: Record<string, string> = { kanban: '任务看板', calculator: '计算器', habit: '习惯打卡' }
  return {
    title: mode === 'edit' ? cleanTitle(prompt) : names[kind] || cleanTitle(prompt),
    summary:
      mode === 'edit'
        ? '在保持现有功能与数据结构的前提下，按你的要求做一次增量调整。'
        : `根据「${prompt.slice(0, 60)}」生成一个可直接操作的单页应用，核心数据保存在云端。`,
    views: ['主界面：核心操作与结果反馈', '数据区：列表 / 记录 / 历史', '状态区：统计与空态提示'],
    features: ['新增与编辑核心数据', '操作后即时反馈', '刷新后数据仍在', '移动端可用'],
    design: '浅色背景 + 白色卡片 + 单一主色，圆角与留白统一，375px 不横向溢出',
    data: 'localStorage（由沙箱运行时同步到云端，键名保持不变）',
    checklist: [
      { id: 'c1', text: '首屏可直接使用，无白屏或明显错位' },
      { id: 'c2', text: '至少 2 处可交互控件（按钮 / 输入 / 选项）' },
      { id: 'c3', text: '操作后界面有即时反馈（列表、数值或状态变化）' },
      { id: 'c4', text: '刷新页面后，之前写入的数据仍然存在' },
      { id: 'c5', text: '375px 宽度下无横向滚动条' },
      { id: 'c6', text: '浏览器控制台无未捕获的 JS 报错' },
    ],
    source: 'mock',
  }
}

function sanitizePlan(raw: any, prompt: string, mode: 'create' | 'edit'): Plan {
  const fallback = mockPlan(prompt, mode)
  if (!raw || typeof raw !== 'object') return { ...fallback, notes: '规划输出格式异常，已使用内置方案' }
  const strArray = (v: any, max: number): string[] =>
    Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim()).slice(0, max).map((s) => s.trim().slice(0, 120)) : []
  const title = typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim().slice(0, 24) : fallback.title
  const checklistRaw = Array.isArray(raw.checklist) ? raw.checklist : []
  const checklist: ChecklistItem[] = checklistRaw
    .filter((x: any) => typeof x === 'string' && x.trim())
    .slice(0, 8)
    .map((text: string, i: number) => ({ id: `c${i + 1}`, text: text.trim().slice(0, 120) }))
  if (checklist.length < 5) {
    return {
      ...fallback,
      title,
      checklist: fallback.checklist,
      notes: '模型给出的验收清单不足 5 条，已使用内置清单',
    }
  }
  return {
    title,
    summary: typeof raw.summary === 'string' ? raw.summary.trim().slice(0, 300) : fallback.summary,
    views: strArray(raw.views, 4).length ? strArray(raw.views, 4) : fallback.views,
    features: strArray(raw.features, 6).length ? strArray(raw.features, 6) : fallback.features,
    design: typeof raw.design === 'string' ? raw.design.trim().slice(0, 200) : fallback.design,
    data: typeof raw.data === 'string' ? raw.data.trim().slice(0, 200) : fallback.data,
    checklist,
    source: 'model',
  }
}

const PLANNER_SYSTEM = `你是一名产品规划师（代号 Mike）。你的任务是把用户的一句话需求，拆解成一份可以直接交给工程师实现、并且可以逐条验收的方案。
只输出 JSON，不要输出任何解释文字或 Markdown 代码块。JSON 结构如下：
{"title":"不超过 20 字的标题","summary":"2-3 句说明做什么、给谁用","views":["页面/区域 1","页面/区域 2"],"features":["功能 1","功能 2","功能 3","功能 4"],"design":"视觉与布局要求","data":"数据如何保存（必须使用 localStorage）","checklist":["可验收标准 1","可验收标准 2","可验收标准 3","可验收标准 4","可验收标准 5","可验收标准 6"]}
要求：
1) 必须生成一个单文件、纯前端、可交互的网页应用，覆盖用户需求的核心操作；
2) checklist 必须 5-8 条，每条都可通过"页面是否可点、数据是否保留、是否报错"等客观现象判定；
3) 不要引入登录、支付、后端接口、外部图片/字体/CDN。`

export async function createPlan(input: {
  prompt: string
  mode: 'create' | 'edit'
  onDelta?: (chars: number) => void
}): Promise<Plan> {
  if (isMockMode()) {
    return mockPlan(input.prompt, input.mode)
  }
  const userPrompt =
    input.mode === 'edit'
      ? `用户对现有应用提出了修改要求：\n${input.prompt}\n请给出本次调整的方案（可以是局部改进），保持现有功能不倒退。`
      : `用户需求：\n${input.prompt}\n请拆解并给出方案。`
  try {
    const result = await streamChat(
      [
        { role: 'system', content: PLANNER_SYSTEM },
        { role: 'user', content: userPrompt },
      ],
      (delta) => input.onDelta?.((delta || '').length),
    )
    const text = result.text
    const start = text.indexOf('{')
    const end = text.lastIndexOf('}')
    if (start === -1 || end === -1) throw new Error('规划结果中未找到 JSON')
    const raw = JSON.parse(text.slice(start, end + 1))
    return { ...sanitizePlan(raw, input.prompt, input.mode), model: result.model }
  } catch (err) {
    const fallback = mockPlan(input.prompt, input.mode)
    fallback.notes = `规划模型不可用（${(err as Error).message.slice(0, 120)}），已切换为内置方案`
    return fallback
  }
}

export function planToPrompt(plan: Plan): string {
  return [
    `标题：${plan.title}`,
    `概述：${plan.summary}`,
    `页面：${plan.views.join('；')}`,
    `功能：${plan.features.join('；')}`,
    `设计：${plan.design}`,
    `数据：${plan.data}`,
    `验收标准：${plan.checklist.map((c) => c.text).join('；')}`,
  ].join('\n')
}

export { escapeHtml }
