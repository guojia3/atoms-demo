// 静态完整性检查：满分 10 分，确定性判定
export interface StaticItem {
  key: string
  label: string
  pass: boolean
  detail: string
  points: number
}

export interface StaticResult {
  items: StaticItem[]
  score: number
  ok: boolean
  errors: string[]
}

export function staticCheck(html: string): StaticResult {
  const text = html || ''
  const trimmed = text.trim()
  const hasDoctype = /^<!DOCTYPE\s+html>/i.test(trimmed)
  const hasClose = /<\/html>\s*$/.test(trimmed)
  const hasScript = /<script[^>]*>[\s\S]*?<\/script>/i.test(text)
  const hasViewport = /<meta[^>]+name=["']viewport["'][^>]*>/i.test(text)
  const externalMatches = Array.from(
    text.matchAll(/(?:src|href)\s*=\s*["'](https?:)?\/\/[^"']+["']/gi),
  )
  const hasExternal = externalMatches.length > 0
  const longEnough = trimmed.length >= 2048

  const items: StaticItem[] = [
    { key: 'doctype', label: '包含 <!DOCTYPE html>', pass: hasDoctype, detail: hasDoctype ? '已声明' : '缺少 doctype', points: 1 },
    { key: 'close', label: '以 </html> 结束', pass: hasClose, detail: hasClose ? '结构完整' : '文件可能被截断', points: 1 },
    { key: 'script', label: '包含内联脚本', pass: hasScript, detail: hasScript ? '存在 <script>' : '无脚本，页面不可交互', points: 2 },
    { key: 'viewport', label: '包含 viewport meta', pass: hasViewport, detail: hasViewport ? '已适配移动端' : '缺少 viewport', points: 2 },
    {
      key: 'external',
      label: '无外部依赖',
      pass: !hasExternal,
      detail: hasExternal ? `发现 ${externalMatches.length} 个外链资源（离线环境会加载失败）` : '全部资源内联',
      points: 2,
    },
    { key: 'length', label: '内容长度 ≥ 2KB', pass: longEnough, detail: `当前 ${Math.round(trimmed.length / 1024 * 10) / 10}KB`, points: 2 },
  ]
  const score = items.reduce((sum, it) => sum + (it.pass ? it.points : 0), 0)
  const errors = items.filter((i) => !i.pass).map((i) => i.label)
  return { items, score, ok: items.every((i) => i.pass), errors }
}

/** 从模型输出中提取完整 HTML（去掉 Markdown 围栏与前后解释） */
export function extractHtml(raw: string): string {
  let text = raw.trim()
  const fence = text.match(/```(?:html|HTML)?\s*([\s\S]*?)```/)
  if (fence) text = fence[1].trim()
  const lower = text.toLowerCase()
  const start = lower.indexOf('<!doctype html')
  if (start > 0) text = text.slice(start)
  else if (start === -1) {
    const htmlStart = lower.indexOf('<html')
    if (htmlStart > 0) text = text.slice(htmlStart)
  }
  const end = text.toLowerCase().lastIndexOf('</html>')
  if (end !== -1) text = text.slice(0, end + 7)
  return text.trim()
}
