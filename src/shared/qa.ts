// QA 测试阶段共享契约：DOM 功能清单 → 确定性用例选择 → 验收映射
export type QaCaseKind =
  | 'load'
  | 'viewport'
  | 'main-flow'
  | 'buttons'
  | 'invalid-input'
  | 'delete'
  | 'clear'
  | 'persistence'
  | 'double-click'
  | 'keyboard'
  | 'last-delete'

export interface QaFeatures {
  hasInput: boolean
  hasPrimary: boolean
  hasSecondary: boolean
  hasDelete: boolean
  hasClear: boolean
  hasList: boolean
  /** 预检时的可见列表项数量；用于刷新验证判断页面是否应恢复列表 */
  itemCount: number
  /** 页面是否声明了列表容器（ul/ol、*list*、*history*） */
  listLike: boolean
  hasStorage: boolean
  hasKeyboard: boolean
  overflow: boolean
  width: number
}

export interface QaCaseSpec {
  kind: QaCaseKind
  title: string
}

export interface QaCase extends QaCaseSpec {
  id: string
  status: 'passed' | 'failed'
  evidence: string
  durationMs: number
}

export interface QaReport {
  status: 'passed' | 'failed'
  cases: QaCase[]
  total: number
  passed: number
  failed: number
  durationMs: number
  width: number
  repairRounds?: number
  maxRepairRounds?: number
  blocked?: boolean
  /** 本轮实际复测的用例类型（修复轮只复测失败用例 + 冒烟） */
  retested?: QaCaseKind[]
}

export interface AcceptanceItem {
  id: string
  text: string
  status: 'passed' | 'failed'
  core: boolean
  caseIds: string[]
  evidence: string
}

export interface AcceptanceReport {
  score: number
  items: AcceptanceItem[]
  coreFailed: boolean
  blocked: boolean
  maxRepairRounds: number
  repairRounds: number
}

export const QA_MAX_CASES = 10
export const QA_MAX_REPAIR_ROUNDS = 2

export const QA_CASE_TITLES: Record<QaCaseKind, string> = {
  load: '页面加载与无报错',
  viewport: '375px 无横向溢出',
  'main-flow': '主流程：主要按钮可用',
  buttons: '主要按钮可交互',
  'invalid-input': '表单：空输入/非法输入',
  delete: '删除一条记录',
  clear: '清空列表',
  persistence: '刷新后数据仍在',
  'double-click': '快速双击主要按钮',
  keyboard: '键盘回车提交',
  'last-delete': '删除最后一条记录',
}

/** 修复轮复测：只跑上一轮失败用例 + 1 条冒烟（load 失败时用 viewport，持久化失败时用主流程造数） */
export function buildRetestPlan(failed: QaCaseKind[]): QaCaseSpec[] {
  const kinds = [...new Set(failed)]
  const smoke: QaCaseKind = kinds.includes('persistence')
    ? 'main-flow'
    : kinds.includes('load')
      ? 'viewport'
      : 'load'
  if (!kinds.includes(smoke)) kinds.push(smoke)
  return kinds.slice(0, QA_MAX_CASES).map((kind) => ({ kind, title: QA_CASE_TITLES[kind] }))
}

/** 已用完修复轮次且仍有失败：停在报告，不再提供一键修复（与核心缺失的 blocked 区分） */
export function isRepairLimitReached(qa: QaReport | null | undefined): boolean {
  if (!qa || (qa.failed || 0) === 0) return false
  return (qa.repairRounds ?? 0) >= (qa.maxRepairRounds ?? QA_MAX_REPAIR_ROUNDS)
}

/** 根据实际 DOM 功能清单选择用例；没有对应功能的目标不生成用例 */
export function chooseQaCases(features: QaFeatures): QaCaseSpec[] {
  const specs: QaCaseSpec[] = [
    { kind: 'load', title: '页面加载与无报错' },
    { kind: 'viewport', title: `${features.width}px 无横向溢出` },
  ]
  if (features.hasPrimary) specs.push({ kind: 'main-flow', title: '主流程：主要按钮可用' })
  if (features.hasInput && features.hasPrimary) specs.push({ kind: 'invalid-input', title: '表单：空输入/非法输入' })
  if (features.hasInput && features.hasKeyboard) specs.push({ kind: 'keyboard', title: '键盘回车提交' })
  if (features.hasDelete && features.hasList) specs.push({ kind: 'delete', title: '删除一条记录' })
  if (features.hasClear && features.hasList) specs.push({ kind: 'clear', title: '清空列表' })
  if (features.hasDelete && features.hasList) specs.push({ kind: 'last-delete', title: '删除最后一条记录' })
  if (features.hasStorage) specs.push({ kind: 'persistence', title: '刷新后数据仍在' })
  if (features.hasPrimary) specs.push({ kind: 'double-click', title: '快速双击主要按钮' })
  if (features.hasSecondary) specs.push({ kind: 'buttons', title: '主要按钮可交互' })
  return specs.slice(0, QA_MAX_CASES)
}

const RULES: Array<{ kinds: QaCaseKind[]; test: RegExp }> = [
  { kinds: ['delete'], test: /删除|移除/ },
  { kinds: ['clear'], test: /清空|重置|全部删除/ },
  { kinds: ['persistence'], test: /刷新|持久|保存|localStorage|数据还在/i },
  { kinds: ['viewport'], test: /375|移动|手机|横向|响应式/ },
  { kinds: ['keyboard'], test: /键盘|回车|方向键|滑动/ },
  { kinds: ['invalid-input'], test: /输入|表单|校验|空态|非法/ },
  { kinds: ['main-flow', 'double-click'], test: /交互|按钮|添加|新增|提交|操作|创建|记录|生成|点击/ },
  { kinds: ['load'], test: /首屏|加载|白屏|错位|可用|报错/ },
]

/** 验收只收录“有已执行 QA 用例”的条目；核心条目缺少功能时显式失败 */
export function buildAcceptance(
  checklist: Array<{ id: string; text: string }>,
  qa: QaReport,
  repairRounds = 0,
): AcceptanceReport {
  const items: AcceptanceItem[] = checklist.map((item, index) => {
    const matchedKinds = RULES.filter((rule) => rule.test.test(item.text)).flatMap((rule) => rule.kinds)
    const matched = qa.cases.filter((c) => matchedKinds.includes(c.kind))
    const core = index < 2 || /首屏|主流程|核心|直接使用|基础可用/.test(item.text)
    if (matched.length === 0) {
      return {
        id: item.id,
        text: item.text,
        status: core ? 'failed' : 'passed',
        core,
        caseIds: [],
        evidence: core ? '未找到对应功能（无已执行 QA 用例）' : '未实现（可选，省略）',
      }
    }
    const failed = matched.filter((c) => c.status === 'failed')
    return {
      id: item.id,
      text: item.text,
      status: failed.length ? 'failed' : 'passed',
      core,
      caseIds: matched.map((c) => c.id),
      evidence: failed.length
        ? failed.map((c) => `${c.title}：${c.evidence}`).join('；')
        : matched.map((c) => `${c.title}：${c.evidence}`).join('；'),
    }
  })
  const effective = items.filter((item) => item.caseIds.length > 0 || item.core)
  const passed = effective.filter((item) => item.status === 'passed').length
  const coreFailed = effective.some((item) => item.core && item.status === 'failed')
  return {
    score: effective.length ? Math.round((40 * passed) / effective.length) : 0,
    items: effective,
    coreFailed,
    blocked: coreFailed && repairRounds >= QA_MAX_REPAIR_ROUNDS,
    maxRepairRounds: QA_MAX_REPAIR_ROUNDS,
    repairRounds,
  }
}
