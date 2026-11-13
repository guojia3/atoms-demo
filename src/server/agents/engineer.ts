// 工程师 Alex：单文件 HTML 生成；编辑优先全量重写（Patch 作为 P1 在 runner 内实现）
import { isMockMode } from '../config.js'
import { streamChat } from '../llm/client.js'
import { escapeHtml, mockHtml, pickTemplate, type TemplateKind } from '../mock/templates.js'
import { extractHtml, staticCheck } from '../verify/static-check.js'
import type { Plan } from './planner.js'

export interface GeneratedCandidate {
  html: string
  model: string
  source: 'model' | 'mock' | 'fallback'
  notes: string[]
  durationMs: number
  error?: string
}

const ENGINEER_SYSTEM = `你是一名资深前端工程师（代号 Alex）。你只输出一个完整的、可直接运行的单文件 HTML 页面。
硬性要求：
1) 从 <!DOCTYPE html> 开始，到 </html> 结束；只输出 HTML 本身，不要解释、不要 Markdown 代码块；
2) 所有 CSS 和 JS 必须内联，禁止引用任何外部资源（CDN、字体、图片外链、接口请求）；
3) 必须至少包含 2 处可交互控件，并有明确的视觉反馈；不要只做静态展示；
4) 所有业务数据必须通过 localStorage 读写（键名固定、不随刷新变化），不要使用 sessionStorage 存业务数据；
5) 首屏信息完整：标题、主要操作区、数据区；空态要有提示；
6) 使用系统字体栈，浅色背景 + 白色卡片，主色不超过 2 种，圆角 12-16px，按钮/输入有 hover/focus 态；
7) 375px 宽度可用：使用 flex/grid 与 minmax，禁止固定大宽度导致横向滚动；
8) 代码要精炼但功能完整，页面至少 60 行、总大小不少于 3KB。`

// 编辑优先走"局部补丁"：模型输出 find/replace，应用失败再回退全量重写
export const PATCH_SYSTEM = `你是一名资深前端工程师（代号 Alex），正在对一份已有的单文件 HTML 做增量修改。
只输出一个严格 JSON 对象，不要解释、不要 Markdown 代码块：
- 默认必须输出局部补丁：{"patches":[{"find":"当前 HTML 中逐字符一致的原文","replace":"替换后的内容"}]}，一次 1-3 处；
- find 必须从当前 HTML 中原样复制（含缩进、换行、引号与空格），长度 20-1200 字符，且全文只出现一次；
- 为保证唯一性，find 要包含足够上下文：优先选整行/整段/完整标签（建议 2-6 行），禁止只复制短词、常见类名、重复属性或省略号；
- 插入内容时，用紧邻的唯一锚点作为 find，并在 replace 中原样保留锚点后再追加；
- 不得臆造原文：find 必须在当前 HTML 精确命中且仅命中一次；
- 仅当需要大面积结构重写（预计改动超过全文 40%）时，才输出 {"full":"<!DOCTYPE html>...完整的 HTML"}；
- 除非用户明确要求，不要改动 localStorage 键名、已有功能与数据结构。`

interface PatchInstruction {
  find: string
  replace: string
}

export function parsePatchOutput(raw: string): { html?: string; patches?: PatchInstruction[] } | null {
  const text = raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end <= start) return null
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as { full?: unknown; patches?: unknown }
    if (typeof parsed.full === 'string' && parsed.full.includes('<')) return { html: parsed.full }
    if (Array.isArray(parsed.patches)) {
      const patches: PatchInstruction[] = []
      for (const item of parsed.patches) {
        if (!item || typeof item !== 'object') return null
        const find = (item as PatchInstruction).find
        const replace = (item as PatchInstruction).replace
        if (typeof find !== 'string' || typeof replace !== 'string' || find.length < 8) return null
        patches.push({ find, replace })
      }
      if (patches.length > 0) return { patches }
    }
  } catch {
    /* noop */
  }
  return null
}

export function applyPatches(html: string, patches: PatchInstruction[]): string | null {
  let out = html
  for (const patch of patches) {
    const first = out.indexOf(patch.find)
    if (first === -1 || out.indexOf(patch.find, first + patch.find.length) !== -1) return null
    out = out.slice(0, first) + patch.replace + out.slice(first + patch.find.length)
  }
  return out
}

function buildPatchPrompt(plan: Plan, prompt: string, baseHtml: string): string {
  return [
    `方案摘要：${plan.title}｜${plan.summary}`,
    `用户修改要求：${prompt}`,
    `当前版本 HTML（以下为可用于补丁定位的完整上下文；若需改动未展示的部分，只能改为输出 full）：\n${baseHtml.slice(0, 24000)}`,
    '请优先输出 JSON 补丁（find 必须逐字符复制且全文唯一）；确实需要大面积重写时才输出 full。',
  ].join('\n\n')
}

function buildUserPrompt(plan: Plan, prompt: string, baseHtml: string | null): string {
  const parts = [`方案：\n${planText(plan)}`, `用户原始需求：${prompt}`]
  if (baseHtml) {
    parts.push(
      `当前线上版本 HTML（请在它基础上修改，保留未要求改动的功能、数据结构与 localStorage 键名）：\n${baseHtml.slice(0, 24000)}`,
    )
  }
  parts.push('请直接输出修改/生成后的完整 HTML。')
  return parts.join('\n\n')
}

function planText(plan: Plan): string {
  return [
    `标题：${plan.title}`,
    `概述：${plan.summary}`,
    `页面：${plan.views.join('；')}`,
    `功能：${plan.features.join('；')}`,
    `设计：${plan.design}`,
    `数据：${plan.data}`,
    `验收清单：${plan.checklist.map((c) => `${c.id}. ${c.text}`).join(' / ')}`,
  ].join('\n')
}

const VARIANT_COLORS: Record<TemplateKind, Array<[string, string]>> = {
  kanban: [
    ['#4f46e5', '#0f766e'],
    ['#4338ca', '#115e59'],
    ['#eef2ff', '#ecfdf5'],
  ],
  calculator: [
    ['#4f46e5', '#0d9488'],
    ['#4338ca', '#0f766e'],
  ],
  habit: [
    ['#16a34a', '#ea580c'],
    ['#15803d', '#c2410c'],
    ['#dcfce7', '#ffedd5'],
    ['#86efac', '#fed7aa'],
    ['#166534', '#9a3412'],
    ['#eff4f0', '#fff7ed'],
  ],
}

/** 赛马时给第二路候选切换主色，保证肉眼可区分，便于演示择优 */
function withVariant(html: string, kind: TemplateKind, variant: number): string {
  if (variant <= 0) return html
  let out = html
  for (const [from, to] of VARIANT_COLORS[kind]) out = out.split(from).join(to)
  return out
}

export function mockGenerated(
  prompt: string,
  mode: 'create' | 'edit',
  baseHtml: string | null,
  plan: Plan,
  variant = 0,
): GeneratedCandidate {
  const started = Date.now()
  if (mode === 'edit' && baseHtml) {
    const note = escapeHtml(prompt.slice(0, 100))
    const banner = `\n<div id="atoms-edit-banner" style="position:fixed;left:16px;bottom:16px;z-index:9999;background:#eef2ff;color:#4338ca;border:1px solid #c7d2fe;border-radius:12px;padding:10px 14px;font:13px/1.5 -apple-system,BlinkMacSystemFont,'PingFang SC',sans-serif;box-shadow:0 8px 24px rgba(79,70,229,.18);max-width:320px">已按你的要求调整：${note}</div>\n`
    const html = /<\/body>/i.test(baseHtml) ? baseHtml.replace(/<\/body>/i, `${banner}</body>`) : baseHtml + banner
    return {
      html,
      model: 'atoms-mock',
      source: 'mock',
      notes: ['演示模式：已基于当前版本生成增量版本'],
      durationMs: Date.now() - started,
    }
  }
  const kind = pickTemplate(prompt)
  return {
    html: withVariant(mockHtml(kind, prompt), kind, variant),
    model: 'atoms-mock',
    source: 'mock',
    notes: [`演示模式：使用内置「${kind === 'kanban' ? '任务看板' : kind === 'calculator' ? '计算器' : '习惯打卡'}」模板`],
    durationMs: Date.now() - started,
  }
}

export async function generateCandidate(input: {
  plan: Plan
  prompt: string
  mode: 'create' | 'edit'
  baseHtml: string | null
  variant?: number
  preferredModel?: string
  onProgress: (chars: number, tail: string) => void
}): Promise<GeneratedCandidate> {
  const started = Date.now()
  const variant = input.variant ?? 0

  if (isMockMode()) {
    // 模拟短暂生成过程，让时间线可见，但整体依然很快
    const candidate = mockGenerated(input.prompt, input.mode, input.baseHtml, input.plan, variant)
    for (let i = 1; i <= 3; i++) {
      await new Promise((r) => setTimeout(r, 110 + variant * 40))
      const chars = Math.round((candidate.html.length * i) / 3)
      input.onProgress(chars, candidate.html.slice(Math.max(0, chars - 80), chars))
    }
    return candidate
  }

  let lastError: Error | null = null
  for (let attempt = 0; attempt < 2; attempt++) {
    const usePatch = attempt === 0 && input.mode === 'edit' && !!input.baseHtml
    try {
      const feedback =
        attempt === 0
          ? ''
          : `\n\n上一次输出不可用（${lastError?.message || '结构不完整'}）。请重新输出完整 HTML，务必以 <!DOCTYPE html> 开头、以 </html> 结尾，并包含内联 <script>。`
      const result = await streamChat(
        [
          { role: 'system', content: usePatch ? PATCH_SYSTEM : ENGINEER_SYSTEM },
          {
            role: 'user',
            content: usePatch
              ? buildPatchPrompt(input.plan, input.prompt, input.baseHtml!) + feedback
              : buildUserPrompt(input.plan, input.prompt, input.baseHtml) + feedback,
          },
        ],
        (delta, meta) => {
          input.onProgress(meta.chars, delta)
        },
        input.preferredModel,
      )

      let html: string | null = null
      let note = ''
      if (usePatch) {
        const parsed = parsePatchOutput(result.text)
        if (parsed?.patches) {
          html = applyPatches(input.baseHtml!, parsed.patches)
          if (!html) {
            lastError = new Error('补丁定位失败（find 未命中或命中多处），已回退全量重写')
            continue
          }
          note = `局部修改 ${parsed.patches.length} 处`
        } else if (parsed?.html) {
          html = extractHtml(parsed.html)
          note = '模型选择整体重写'
        } else {
          lastError = new Error('模型未返回可解析的补丁或完整 HTML')
          continue
        }
      } else {
        html = extractHtml(result.text)
      }
      const check = staticCheck(html)
      if (!check.ok) {
        lastError = new Error(check.errors.join('、'))
        continue
      }
      return {
        html,
        model: result.model,
        source: 'model',
        notes: [note, result.truncated ? '输出接近长度上限，已通过静态检查' : ''].filter(Boolean),
        durationMs: Date.now() - started,
      }
    } catch (err) {
      lastError = err as Error
    }
  }

  // 真实模型失败：创作任务用模板兜底（保证一定能看到预览）；编辑任务不覆盖旧版本
  if (input.mode === 'edit') {
    throw new Error(`本次修改未生成可用页面：${lastError?.message || '模型不可用'}`)
  }
  const fallback = mockGenerated(input.prompt, 'create', null, input.plan)
  return {
    ...fallback,
    source: 'fallback',
    notes: [`模型不可用（${lastError?.message?.slice(0, 100) || '未知错误'}），已降级为内置模板`],
    error: lastError?.message,
  }
}
