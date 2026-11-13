// 模板共用：HTML 转义与基础样式片段
export function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** 统一样式基线：375px 不横向溢出、无外部字体/资源 */
export const BASE_CSS = `
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;min-height:100vh}
  button{font-family:inherit}
  input,textarea,select{font-family:inherit}
`
