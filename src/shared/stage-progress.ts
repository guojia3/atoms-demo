// 工作台预览区阶段进度：把现有 SSE step / candidate / version / report / done 映射为六阶段
export type StageKey = 'plan' | 'generate' | 'race' | 'qa' | 'acceptance' | 'done'
export type StageStatus = 'pending' | 'running' | 'done' | 'skipped' | 'failed'
export type StageOverall = 'running' | 'done' | 'failed' | 'stopped'

export interface StageStepState {
  status: 'running' | 'done' | 'failed'
  detail?: string
}

export interface StageVersionInfo {
  seq: number
  score: number | null
  needsFix?: boolean
}

export interface StageProgressInput {
  runStatus: 'idle' | 'running' | 'done' | 'failed' | 'stopped'
  steps: Record<string, StageStepState | undefined>
  /** 当前 run 是否已经出现可预览的首候选（不是旧版本残留的预览） */
  hasFirstCandidate: boolean
  /** 当前 run 是否已经保存版本 */
  hasVersion: boolean
  /** version 事件里的 qa 开关；未收到前为 null */
  qaEnabled: boolean | null
  hasReport: boolean
  hasConclusion: boolean
  version?: StageVersionInfo | null
  /** 无活动 run 的历史项目：QA 是否执行过 */
  completedQa?: 'done' | 'skipped' | null
  error?: string
}

export interface StageItem {
  key: StageKey
  label: string
  status: StageStatus
  statusLabel: string
}

export interface StageProgress {
  visible: boolean
  stages: StageItem[]
  currentIndex: number
  currentKey: StageKey
  currentLabel: string
  overall: StageOverall
  summary: string
  description: string
}

export const STAGE_ORDER: StageKey[] = ['plan', 'generate', 'race', 'qa', 'acceptance', 'done']
export const STAGE_LABELS: Record<StageKey, string> = {
  plan: '需求规划',
  generate: '生成',
  race: '赛马',
  qa: '测试',
  acceptance: '验收',
  done: '完成',
}
const STATUS_LABELS: Record<StageStatus, string> = {
  pending: '待执行',
  running: '进行中',
  done: '已完成',
  skipped: '已跳过',
  failed: '失败',
}

const DEFAULT_HINTS: Record<StageKey, string> = {
  plan: '正在拆解需求与验收标准',
  generate: '正在生成页面，等待首候选',
  race: '首候选已就绪，正在等待其余候选',
  qa: '在隐藏沙箱执行实际功能用例',
  acceptance: '正在把 QA 结果映射到验收清单',
  done: '正在保存版本与结论',
}

/** 纯函数：由现有运行时状态推导六阶段，便于单元测试与左右状态一致 */
export function deriveStageProgress(input: StageProgressInput): StageProgress {
  const idleCompleted = input.runStatus === 'idle' && input.hasVersion
  const overall: StageOverall = idleCompleted
    ? 'done'
    : input.runStatus === 'failed'
      ? 'failed'
      : input.runStatus === 'stopped'
        ? 'stopped'
        : input.runStatus === 'done'
          ? 'done'
          : 'running'
  const visible = input.runStatus !== 'idle' || idleCompleted
  const hasFirst = idleCompleted || input.hasFirstCandidate
  const hasVersion = idleCompleted || input.hasVersion
  const qaEnabled = idleCompleted
    ? input.completedQa === 'done'
      ? true
      : input.completedQa === 'skipped'
        ? false
        : null
    : input.qaEnabled
  const qaSkipped = qaEnabled === false
  const hasReport = idleCompleted ? input.hasReport : input.hasReport
  const hasConclusion = idleCompleted ? input.hasConclusion : input.hasConclusion

  let currentKey: StageKey
  if (overall === 'done') currentKey = 'done'
  else if (overall === 'failed' || overall === 'stopped') {
    currentKey = hasConclusion
      ? 'done'
      : hasReport
        ? 'acceptance'
        : hasVersion
          ? qaSkipped
            ? 'acceptance'
            : 'qa'
          : hasFirst
            ? 'race'
            : input.steps.generate
              ? 'generate'
              : 'plan'
  } else if (hasReport) currentKey = 'acceptance'
  else if (hasVersion) currentKey = qaSkipped || input.steps.qa?.status === 'done' ? 'acceptance' : 'qa'
  else if (hasFirst) currentKey = 'race'
  else if (input.steps.generate) currentKey = 'generate'
  else currentKey = 'plan'

  const currentIndex = STAGE_ORDER.indexOf(currentKey)
  const stages: StageItem[] = STAGE_ORDER.map((key, index) => {
    let status: StageStatus = 'pending'
    if (overall === 'done') {
      status = key === 'qa' && qaSkipped ? 'skipped' : 'done'
    } else if (index < currentIndex) {
      status = key === 'qa' && qaSkipped ? 'skipped' : 'done'
    } else if (index === currentIndex) {
      status = overall === 'failed' || overall === 'stopped' ? 'failed' : 'running'
    }
    if (key === 'qa') {
      if (qaSkipped && (hasVersion || hasReport || overall === 'done')) status = 'skipped'
      else if (input.steps.qa?.status === 'failed') status = 'failed'
      else if (input.steps.qa?.status === 'done' && status === 'running') status = 'done'
    }
    if (key === 'plan' && input.steps.plan?.status === 'failed' && status !== 'done') status = 'failed'
    if (key === 'generate' && input.steps.generate?.status === 'failed' && status !== 'done') status = 'failed'
    if (key === 'acceptance' && hasReport && status === 'pending') status = 'done'
    return { key, label: STAGE_LABELS[key], status, statusLabel: STATUS_LABELS[status] }
  })

  const detailByKey: Record<StageKey, string | undefined> = {
    plan: input.steps.plan?.detail,
    generate: input.steps.generate?.detail,
    race: input.steps.generate?.detail || input.steps.verify?.detail,
    qa: input.steps.qa?.detail,
    acceptance: input.steps.review?.detail,
    done: input.steps.deliver?.detail,
  }
  let description = detailByKey[currentKey] || DEFAULT_HINTS[currentKey]
  if (overall === 'failed') description = input.error ? `失败：${input.error}` : '任务失败，可查看左侧记录后重试'
  if (overall === 'stopped') description = '任务已停止，可继续编辑或重试'

  let summary: string
  if (overall === 'running') summary = `当前：${STAGE_LABELS[currentKey]} ${currentIndex + 1}/6`
  else if (overall === 'done') {
    const v = input.version
    summary = `完成${v ? ` · v${v.seq}` : ''}${v?.score != null ? ` · ${v.score} 分` : ''}${v?.needsFix ? ' · 待修复' : ''}`
  } else if (overall === 'failed') summary = '失败'
  else summary = '已停止'

  return {
    visible,
    stages,
    currentIndex,
    currentKey,
    currentLabel: STAGE_LABELS[currentKey],
    overall,
    summary,
    description,
  }
}
