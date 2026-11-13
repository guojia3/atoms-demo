// 运行时实测评分（满分 50）：全部来自浏览器沙箱探针上报的客观指标
export interface ProbeMetrics {
  elements: number
  textLength: number
  errors: string[]
  errorCount: number
  clicks: number
  mutations: number
  keys: number
  writes: number
  overflowX: boolean
  width: number
  title: string
  interactiveClicks: number
  simulatedClicks?: number
  simulatedChanges?: number
  simulatedWrites?: number
}

export interface ScorePart {
  key: string
  label: string
  score: number
  max: number
  evidence: string
}

export function scoreProbe(metrics: ProbeMetrics | null): { score: number; items: ScorePart[] } {
  if (!metrics) {
    return {
      score: 0,
      items: [
        { key: 'render', label: '页面渲染', score: 0, max: 10, evidence: '未收到浏览器实测数据（超时）' },
        { key: 'errors', label: '无运行时报错', score: 0, max: 10, evidence: '未收到浏览器实测数据（超时）' },
        { key: 'interactive', label: '交互可用', score: 0, max: 15, evidence: '未收到浏览器实测数据（超时）' },
        { key: 'persist', label: '数据持久化调用', score: 0, max: 10, evidence: '未收到浏览器实测数据（超时）' },
        { key: 'mobile', label: '移动端适配', score: 0, max: 5, evidence: '未收到浏览器实测数据（超时）' },
      ],
    }
  }

  const elements = metrics.elements || 0
  const textLength = metrics.textLength || 0
  const errors = metrics.errorCount ?? (metrics.errors?.length || 0)
  const simulatedClicks = metrics.simulatedClicks ?? 0
  const simulatedChanges = metrics.simulatedChanges ?? 0
  const writes = metrics.writes || 0
  const keys = metrics.keys || 0

  const items: ScorePart[] = []

  const renderScore = elements >= 15 && textLength >= 40 ? 10 : elements >= 8 && textLength >= 15 ? 6 : elements > 0 ? 3 : 0
  items.push({
    key: 'render',
    label: '页面渲染',
    score: renderScore,
    max: 10,
    evidence: `检测到 ${elements} 个元素、${textLength} 个可见字符${textLength < 40 ? '（内容偏少）' : ''}`,
  })

  const errorScore = errors === 0 ? 10 : errors === 1 ? 6 : errors === 2 ? 3 : 0
  items.push({
    key: 'errors',
    label: '无运行时报错',
    score: errorScore,
    max: 10,
    evidence: errors === 0 ? '未捕获到 JS 报错' : `捕获 ${errors} 条报错：${(metrics.errors || []).slice(0, 2).join(' / ').slice(0, 160)}`,
  })

  const interactScore = simulatedClicks >= 2 && simulatedChanges >= 1 ? 15 : simulatedClicks >= 1 && simulatedChanges >= 1 ? 11 : simulatedClicks >= 1 ? 6 : 0
  items.push({
    key: 'interactive',
    label: '交互可用',
    score: interactScore,
    max: 15,
    evidence: `模拟点击 ${simulatedClicks} 个控件，触发 ${simulatedChanges} 次界面变化`,
  })

  const persistScore = writes >= 1 || keys >= 1 ? 10 : 0
  items.push({
    key: 'persist',
    label: '数据持久化调用',
    score: persistScore,
    max: 10,
    evidence: writes >= 1 || keys >= 1 ? `检测到 ${Math.max(writes, keys)} 次 localStorage 写入/存量键` : '未检测到 localStorage 调用',
  })

  items.push({
    key: 'mobile',
    label: '移动端适配',
    score: metrics.overflowX ? 0 : 5,
    max: 5,
    evidence: metrics.overflowX ? `在 ${metrics.width}px 视口下出现横向溢出` : `在 ${metrics.width}px 视口下无横向溢出`,
  })

  return { score: items.reduce((s, i) => s + i.score, 0), items }
}
