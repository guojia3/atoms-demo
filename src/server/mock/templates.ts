// 内置演示模板注册表：无模型 / 模型失败时的一等公民，保证任何情况下都有可交互、可持久化的成品
import { escapeHtml } from './kinds/shared.js'
import { kanbanHtml } from './kinds/kanban.js'
import { habitHtml } from './kinds/habit.js'
import { game2048Html } from './kinds/game2048.js'
import { pomodoroHtml } from './kinds/pomodoro.js'
import { notesHtml } from './kinds/notes.js'
import { expenseHtml } from './kinds/expense.js'

export type TemplateKind = 'kanban' | 'habit' | 'game2048' | 'pomodoro' | 'notes' | 'expense'

export const TEMPLATE_LABELS: Record<TemplateKind, string> = {
  kanban: '任务看板',
  habit: '习惯打卡',
  game2048: '2048',
  pomodoro: '番茄专注',
  notes: 'Markdown 笔记',
  expense: '记账本',
}

export function pickTemplate(prompt: string): TemplateKind {
  const p = prompt.toLowerCase()
  // 先匹配特征强的品类，避免「待办/清单」把看板误判成打卡
  if (/2048|数字合并|合并方块|益智游戏/.test(p)) return 'game2048'
  if (/番茄|pomodoro|专注|倒计时|计时器/.test(p)) return 'pomodoro'
  if (/记账|账本|支出|收入|预算|花销/.test(p)) return 'expense'
  if (/笔记|markdown|写作|灵感|草稿/.test(p)) return 'notes'
  if (/打卡|习惯|habit|坚持/.test(p)) return 'habit'
  return 'kanban'
}

export function mockHtml(kind: TemplateKind, prompt: string): string {
  if (kind === 'habit') return habitHtml(prompt)
  if (kind === 'game2048') return game2048Html(prompt)
  if (kind === 'pomodoro') return pomodoroHtml(prompt)
  if (kind === 'notes') return notesHtml(prompt)
  if (kind === 'expense') return expenseHtml(prompt)
  return kanbanHtml(prompt)
}

export { escapeHtml }
