// 验收官：按需求清单逐条判定（有模型用模型，无模型用可解释的启发式规则）
import { isMockMode } from '../config.js'
import { streamChat } from '../llm/client.js'
import type { ChecklistItem } from './planner.js'
import type { ProbeMetrics } from '../verify/score.js'

export interface ReviewItem {
  id: string
  text: string
  pass: boolean
  evidence: string
}

export interface ChecklistReview {
  items: ReviewItem[]
  score: number
  source: 'model' | 'heuristic'
}

function heuristicItem(item: ChecklistItem, metrics: ProbeMetrics | null, htmlLength: number): ReviewItem {
  if (!metrics) {
    return { id: item.id, text: item.text, pass: false, evidence: '未收到浏览器实测数据，无法判定' }
  }
  const simulatedClicks = metrics.simulatedClicks ?? 0
  const simulatedChanges = metrics.simulatedChanges ?? 0
  const writes = metrics.writes || 0
  const keys = metrics.keys || 0
  const errors = metrics.errorCount ?? 0
  const text = item.text

  let pass = false
  let evidence = ''
  if (/交互|点击|操作|按钮|输入/.test(text)) {
    pass = simulatedClicks >= 2 && simulatedChanges >= 1
    evidence = `模拟点击 ${simulatedClicks} 个控件，触发 ${simulatedChanges} 次界面变化`
  } else if (/持久|刷新|保存|数据|localStorage/i.test(text)) {
    pass = writes >= 1 || keys >= 1
    evidence = pass ? `检测到 ${Math.max(writes, keys)} 次 localStorage 写入` : '未检测到 localStorage 读写'
  } else if (/报错|错误|console|异常/i.test(text)) {
    pass = errors === 0
    evidence = errors === 0 ? '未捕获到 JS 报错' : `捕获 ${errors} 条报错`
  } else if (/移动|375|响应式|小屏|手机/.test(text)) {
    pass = !metrics.overflowX
    evidence = metrics.overflowX ? `在 ${metrics.width}px 视口下出现横向溢出` : `在 ${metrics.width}px 视口下无横向溢出`
  } else if (/白屏|首屏|渲染|加载|错位/.test(text)) {
    pass = metrics.elements >= 15 && metrics.textLength >= 40
    evidence = `检测到 ${metrics.elements} 个元素、${metrics.textLength} 个可见字符`
  } else {
    pass = htmlLength >= 3000 && errors === 0
    evidence = pass ? `页面完整（${Math.round(htmlLength / 1024 * 10) / 10}KB）且无报错` : '未满足通用完整性判定'
  }
  return { id: item.id, text: item.text, pass, evidence }
}

export function heuristicReview(checklist: ChecklistItem[], metrics: ProbeMetrics | null, html: string): ChecklistReview {
  const items = checklist.map((c) => heuristicItem(c, metrics, html.length))
  const passCount = items.filter((i) => i.pass).length
  return {
    items,
    score: checklist.length ? Math.round((40 * passCount) / checklist.length) : 0,
    source: 'heuristic',
  }
}

const REVIEWER_SYSTEM = `你是一名验收官。你会收到一份验收清单和浏览器实测数据摘要。请逐条判断是否通过，并给出一句基于证据的说明。
只输出 JSON 数组，不要输出解释或 Markdown 代码块。数组每一项格式：
{"id":"c1","pass":true,"evidence":"一句话证据"}
要求：evidence 必须引用实测数据或页面事实（如元素数量、点击次数、报错数），不得空泛；不能因为"看起来不错"就通过。`

export async function reviewChecklist(input: {
  checklist: ChecklistItem[]
  metrics: ProbeMetrics | null
  html: string
  prompt: string
}): Promise<ChecklistReview> {
  if (isMockMode() || !input.metrics) {
    return heuristicReview(input.checklist, input.metrics, input.html)
  }
  const metricsSummary = {
    elements: input.metrics.elements,
    textLength: input.metrics.textLength,
    errorCount: input.metrics.errorCount,
    errors: input.metrics.errors.slice(0, 5),
    simulatedClicks: input.metrics.simulatedClicks,
    simulatedChanges: input.metrics.simulatedChanges,
    localStorageWrites: input.metrics.writes,
    localStorageKeys: input.metrics.keys,
    overflowX: input.metrics.overflowX,
    viewportWidth: input.metrics.width,
    title: input.metrics.title,
  }
  try {
    const result = await streamChat(
      [
        { role: 'system', content: REVIEWER_SYSTEM },
        {
          role: 'user',
          content: `用户需求：${input.prompt}\n\n验收清单：\n${input.checklist
            .map((c) => `${c.id}. ${c.text}`)
            .join('\n')}\n\n浏览器实测数据：\n${JSON.stringify(metricsSummary)}\n\n页面 HTML 摘要（前 3000 字符）：\n${input.html.slice(0, 3000)}`,
        },
      ],
      () => {},
    )
    const text = result.text
    const start = text.indexOf('[')
    const end = text.lastIndexOf(']')
    if (start === -1 || end === -1) throw new Error('验收结果不是 JSON 数组')
    const raw = JSON.parse(text.slice(start, end + 1)) as Array<{ id?: string; pass?: boolean; evidence?: string }>
    const byId = new Map(raw.map((r) => [String(r.id || ''), r]))
    const items: ReviewItem[] = input.checklist.map((c, idx) => {
      const matched = byId.get(c.id) || raw[idx]
      const pass = typeof matched?.pass === 'boolean' ? matched.pass : false
      return {
        id: c.id,
        text: c.text,
        pass,
        evidence: (matched?.evidence || '模型未给出明确证据').toString().slice(0, 200),
      }
    })
    const passCount = items.filter((i) => i.pass).length
    return { items, score: input.checklist.length ? Math.round((40 * passCount) / input.checklist.length) : 0, source: 'model' }
  } catch {
    return heuristicReview(input.checklist, input.metrics, input.html)
  }
}
