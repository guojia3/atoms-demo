// 运行编排：规划 → 生成 → 静态检查 → 浏览器实测 → 清单验收 → 采用版本 → 结论
import { config, isMockMode } from '../config.js'
import { emit } from './hub.js'
import { createPlan, mockPlan, type Plan, type ChecklistItem } from '../agents/planner.js'
import { generateCandidate, type GeneratedCandidate } from '../agents/engineer.js'
import { reviewChecklist } from '../agents/reviewer.js'
import { buildAcceptance, QA_MAX_CASES, type QaCase, type QaReport } from '../../shared/qa.js'
import { staticCheck } from '../verify/static-check.js'
import { scoreProbe, type ProbeMetrics } from '../verify/score.js'
import {
  addMessage,
  countFixRunsSinceBase,
  createCandidate,
  createVersion,
  getCandidate,
  getProject,
  getRun,
  getVersion,
  touchProject,
  updateCandidate,
  updateRun,
  updateVersion,
} from '../store.js'

interface PendingReport {
  resolve: (metrics: ProbeMetrics | null) => void
  timer: ReturnType<typeof setTimeout>
}

const pendingReports = new Map<string, PendingReport>()
const receivedReports = new Map<string, ProbeMetrics>()
const stoppedRuns = new Set<string>()
const runControllers = new Map<string, Set<AbortController>>()
const uiRuns = new Set<string>()
const pendingQa = new Map<string, { resolve: (report: QaReport | null) => void; timer: ReturnType<typeof setTimeout> }>()

const STEP_LABELS: Record<string, string> = {
  plan: 'Mike 拆解需求',
  generate: 'Alex 生成页面',
  verify: '静态检查 + 浏览器实测',
  review: '逐条验收',
  qa: 'QA 测试',
  deliver: '保存版本与结论',
}

function emitStep(runId: string, key: string, status: 'running' | 'done' | 'failed', detail?: string): void {
  emit(runId, 'step', { key, label: STEP_LABELS[key] || key, status, detail })
}

function isStopped(runId: string): boolean {
  return stoppedRuns.has(runId)
}

export function stopRun(runId: string): void {
  stoppedRuns.add(runId)
  for (const controller of runControllers.get(runId) || []) {
    try {
      controller.abort()
    } catch {
      /* noop */
    }
  }
  // 取消等待中的 QA，避免停止后仍占着 15s 超时窗口
  const qa = pendingQa.get(runId)
  if (qa) {
    clearTimeout(qa.timer)
    pendingQa.delete(runId)
    qa.resolve(null)
  }
  const run = getRun(runId)
  if (run && run.status === 'running') {
    updateRun(runId, { status: 'stopped', finished_at: new Date().toISOString() })
    emit(runId, 'done', { runId, status: 'stopped' })
  }
}

/** 客户端探针结果回填；候选尚未进入等待时先缓存，避免 early preview 的上报丢失 */
export function resolveReport(candidateId: string, metrics: ProbeMetrics): boolean {
  const pending = pendingReports.get(candidateId)
  if (pending) {
    clearTimeout(pending.timer)
    pendingReports.delete(candidateId)
    pending.resolve(metrics)
    return true
  }
  if (!receivedReports.has(candidateId)) receivedReports.set(candidateId, metrics)
  return false
}

function waitForReport(candidateId: string, timeoutMs: number): Promise<ProbeMetrics | null> {
  const cached = receivedReports.get(candidateId)
  if (cached) {
    receivedReports.delete(candidateId)
    return Promise.resolve(cached)
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingReports.delete(candidateId)
      resolve(null)
    }, timeoutMs)
    pendingReports.set(candidateId, { resolve, timer })
  })
}

function cancelReportWait(candidateId: string): void {
  const pending = pendingReports.get(candidateId)
  if (!pending) return
  clearTimeout(pending.timer)
  pendingReports.delete(candidateId)
  pending.resolve(null)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)))
}

/** 有浏览器 UI 订阅该 run 时才执行 QA，纯 API/烟测不等待隐藏沙箱 */
export function noteUiClient(runId: string): void {
  uiRuns.add(runId)
}

/** 接收隐藏沙箱的 QA 结果；重复/迟到上报忽略 */
export function resolveQa(runId: string, raw: unknown): boolean {
  const pending = pendingQa.get(runId)
  if (!pending) return false
  const payload = (raw || {}) as { cases?: unknown; durationMs?: unknown; width?: unknown; retested?: unknown }
  if (!Array.isArray(payload.cases) || payload.cases.length === 0) return false
  const cases: QaCase[] = payload.cases.slice(0, QA_MAX_CASES).map((item, index) => {
    const c = (item || {}) as Record<string, unknown>
    const status = c.status === 'failed' ? 'failed' : 'passed'
    return {
      id: String(c.id || `qa${index + 1}`).slice(0, 20),
      kind: String(c.kind || 'unknown').slice(0, 40) as QaCase['kind'],
      title: String(c.title || 'QA 用例').slice(0, 120),
      status,
      evidence: String(c.evidence || '').slice(0, 400),
      durationMs: Math.max(0, Math.min(60000, Number(c.durationMs) || 0)),
    }
  })
  clearTimeout(pending.timer)
  pendingQa.delete(runId)
  const retested = Array.isArray(payload.retested)
    ? payload.retested.slice(0, QA_MAX_CASES).map((kind) => String(kind).slice(0, 40) as QaCase['kind'])
    : undefined
  pending.resolve({
    status: cases.some((c) => c.status === 'failed') ? 'failed' : 'passed',
    cases,
    total: cases.length,
    passed: cases.filter((c) => c.status === 'passed').length,
    failed: cases.filter((c) => c.status === 'failed').length,
    durationMs: Math.max(0, Number(payload.durationMs) || 0),
    width: Math.max(0, Number(payload.width) || 0),
    ...(retested?.length ? { retested } : {}),
  })
  return true
}

function waitForQa(runId: string, timeoutMs: number): Promise<QaReport | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingQa.delete(runId)
      resolve(null)
    }, timeoutMs)
    pendingQa.set(runId, { resolve, timer })
  })
}

function candidateModelName(index: number, total: number): string {
  if (isMockMode()) return total > 1 ? `atoms-mock-${String.fromCharCode(65 + index)}` : 'atoms-mock'
  const provider = config.providers[index % Math.max(1, config.providers.length)]
  return provider?.model || 'unknown'
}

function parseChecklist(projectJson: string | null): ChecklistItem[] {
  if (!projectJson) return mockPlan('').checklist
  try {
    const list = JSON.parse(projectJson)
    if (Array.isArray(list) && list.length) return list as ChecklistItem[]
  } catch {
    /* noop */
  }
  return mockPlan('').checklist
}

function parsePlan(projectJson: string | null): Plan | null {
  if (!projectJson) return null
  try {
    const plan = JSON.parse(projectJson)
    if (plan && plan.title) return plan as Plan
  } catch {
    /* noop */
  }
  return null
}

function reportSummary(score: number, parts: { static: number; probe: number; checklist: number }, passCount: number, totalItems: number, notes: string[]): string {
  const lines = [
    `验收完成：总分 ${score}/100（静态 ${parts.static}/10 · 实测 ${parts.probe}/50 · 清单 ${parts.checklist}/40）`,
    `验收清单通过 ${passCount}/${totalItems} 条。`,
  ]
  if (notes.length) lines.push(notes.join('；'))
  return lines.join('\n')
}

async function finishWithFailure(runId: string, projectId: string, message: string): Promise<void> {
  // 用户停止优先：stopRun 已写入 stopped 终态，收尾失败流程不得覆盖
  if (isStopped(runId)) {
    const current = getRun(runId)
    if (current && current.status !== 'stopped') {
      updateRun(runId, { status: 'stopped', finished_at: new Date().toISOString() })
    }
    return
  }
  const text = `本次生成未完成：${message}。已有的历史版本不受影响，可以重试或改用内置模板。`
  addMessage({ projectId, role: 'system', kind: 'text', content: text })
  emit(runId, 'error', { message })
  updateRun(runId, { status: 'failed', error: message, finished_at: new Date().toISOString() })
  emit(runId, 'done', { runId, status: 'failed', message })
}

export async function executeRun(runId: string): Promise<void> {
  const run = getRun(runId)
  if (!run || run.status !== 'running') return
  const project = getProject(run.project_id)
  if (!project) {
    updateRun(runId, { status: 'failed', error: '项目不存在', finished_at: new Date().toISOString() })
    return
  }
  const cleanupCandidateIds: string[] = []

  try {
    const baseHtml = run.base_version_id ? getVersion(run.base_version_id)?.html || null : null
    let checklist = parseChecklist(project.checklist_json)
    const existingPlan = parsePlan(project.plan_json)
    let activePlan: Plan
    const targetPrompt = run.mode === 'create' ? project.prompt : `${project.prompt}\n修改要求：${run.instruction}`

    // 1) 规划
    emitStep(runId, 'plan', 'running')
    if (run.mode === 'create' || !existingPlan) {
      activePlan = await createPlan({
        prompt: targetPrompt,
        mode: run.mode === 'create' ? 'create' : 'edit',
      })
      checklist = activePlan.checklist
      touchProject(project.id, { plan_json: JSON.stringify(activePlan), checklist_json: JSON.stringify(checklist), title: activePlan.title })
      addMessage({
        projectId: project.id,
        role: 'agent',
        kind: 'plan',
        content: `${activePlan.title}：${activePlan.summary}`,
        meta: { plan: activePlan },
      })
      emit(runId, 'plan', { plan: activePlan, checklist })
    } else {
      // 编辑：沿用原清单
      activePlan = { ...existingPlan, checklist }
      emit(runId, 'plan', { plan: activePlan, checklist })
    }
    emitStep(runId, 'plan', 'done', `目标：${activePlan.title}，${checklist.length} 条验收标准`)

    if (isStopped(runId)) return

    // 2) 生成：单路或双路赛马（并行）；首候选就绪即进入预览/实测，其余候选有等待上限
    emitStep(runId, 'generate', 'running')
    const raceCount = config.raceCount
    const startedAt = Date.now()
    const progressAt = new Map<string, number>()
    const slots = Array.from({ length: raceCount }, (_, index) => ({
      index,
      candidate: createCandidate({ runId, model: candidateModelName(index, raceCount) }),
    }))

    type CandidateResult = {
      candidate: ReturnType<typeof createCandidate>
      index: number
      generated: GeneratedCandidate
      staticResult: ReturnType<typeof staticCheck>
    }
    type ScoredCandidate = CandidateResult & {
      checklist: ChecklistItem[]
      metrics: ProbeMetrics | null
      probe: ReturnType<typeof scoreProbe>
      review: Awaited<ReturnType<typeof reviewChecklist>>
      totalScore: number
      report: {
        score: number
        parts: { static: number; probe: number; checklist: number }
        static: ReturnType<typeof staticCheck>
        probe: ReturnType<typeof scoreProbe>['items']
        checklist: Awaited<ReturnType<typeof reviewChecklist>>['items']
        metrics: ProbeMetrics | null
        reviewSource: string
        notes: string[]
      }
    }
    interface CandidateEntry {
      index: number
      candidate: ReturnType<typeof createCandidate>
      controller: AbortController
      status: 'generating' | 'ready' | 'failed' | 'cancelled'
      readyAt?: number
      result?: CandidateResult
      checklist?: ChecklistItem[]
      failureMessage?: string
      metricsPromise?: Promise<ProbeMetrics | null>
      scoredPromise?: Promise<ScoredCandidate>
    }

    const entries: CandidateEntry[] = slots.map((slot) => ({
      ...slot,
      controller: new AbortController(),
      status: 'generating',
    }))
    const runAbortSet = new Set(entries.map((entry) => entry.controller))
    runControllers.set(runId, runAbortSet)
    cleanupCandidateIds.push(...entries.map((entry) => entry.candidate.id))

    const scoreEntry = async (entry: CandidateEntry): Promise<ScoredCandidate> => {
      const item = entry.result!
      const candidateChecklist = entry.checklist || checklist
      const metrics = await (entry.metricsPromise || Promise.resolve(null))
      const probe = scoreProbe(metrics)
      const review = await reviewChecklist({ checklist: candidateChecklist, metrics, html: item.generated.html, prompt: targetPrompt })
      const totalScore = item.staticResult.score + probe.score + review.score
      return {
        ...item,
        checklist: candidateChecklist,
        metrics,
        probe,
        review,
        totalScore,
        report: {
          score: totalScore,
          parts: { static: item.staticResult.score, probe: probe.score, checklist: review.score },
          static: item.staticResult,
          probe: probe.items,
          checklist: review.items,
          metrics,
          reviewSource: review.source,
          notes: item.generated.notes,
        },
      }
    }

    let firstEntry: CandidateEntry | null = null
    let resolveFirst: (entry: CandidateEntry) => void = () => {}
    const firstReady = new Promise<CandidateEntry>((resolve) => {
      resolveFirst = resolve
    })
    let resolveAllDone: () => void = () => {}
    const allDone = new Promise<void>((resolve) => {
      resolveAllDone = resolve
    })
    let settled = 0

    const tasks = entries.map((entry) => {
      const { index, candidate: slotCandidate } = entry
      const task = (async (): Promise<CandidateResult | null> => {
        try {
          const generated = await generateCandidate({
            plan: activePlan,
            prompt: targetPrompt,
            mode: run.mode === 'create' ? 'create' : 'edit',
            baseHtml,
            variant: index,
            preferredModel: isMockMode() ? undefined : slotCandidate.model,
            signal: entry.controller.signal,
            onProgress: (chars, delta) => {
              const now = Date.now()
              if (now - (progressAt.get(slotCandidate.id) || 0) < 450) return
              progressAt.set(slotCandidate.id, now)
              emit(runId, 'progress', {
                candidateId: slotCandidate.id,
                variant: index,
                model: slotCandidate.model,
                chars,
                tail: delta.slice(-120),
                elapsedMs: now - startedAt,
              })
            },
          })

          if (isStopped(runId) || entry.status === 'cancelled' || entry.controller.signal.aborted) {
            entry.status = 'cancelled'
            updateCandidate(slotCandidate.id, { status: 'failed', error: '已取消' })
            return null
          }

          const staticResult = staticCheck(generated.html)
          updateCandidate(slotCandidate.id, {
            status: 'done',
            html: generated.html,
            duration_ms: generated.durationMs,
            error: generated.error || null,
            report_json: JSON.stringify({ static: staticResult, notes: generated.notes }),
          })
          entry.result = { candidate: slotCandidate, index, generated, staticResult }
          entry.status = 'ready'
          entry.readyAt = Date.now()
          if (generated.source === 'fallback') {
            entry.checklist = mockPlan(targetPrompt).checklist
            addMessage({
              projectId: project.id,
              role: 'system',
              kind: 'text',
              content: '演示兜底：模型未能生成可用页面，已使用内置模板；验收清单已切换为该模板的通用标准，产物与原始需求可能不完全一致，建议重试。',
            })
          } else {
            entry.checklist = checklist
          }
          // 先注册等待再发事件，客户端 early preview 的探针回报不会丢
          entry.metricsPromise = waitForReport(slotCandidate.id, config.probeTimeoutMs)
          entry.scoredPromise = scoreEntry(entry)

          emit(runId, 'progress', {
            candidateId: slotCandidate.id,
            variant: index,
            model: generated.model,
            chars: generated.html.length,
            tail: generated.html.slice(-120),
            elapsedMs: Date.now() - startedAt,
            final: true,
          })
          emit(runId, 'candidate', {
            id: slotCandidate.id,
            status: 'done',
            variant: index,
            model: generated.model,
            source: generated.source,
            durationMs: generated.durationMs,
            notes: generated.notes,
            staticScore: staticResult.score,
            previewable: staticResult.ok && generated.html.length > 0,
            first: !firstEntry,
          })
          if (!firstEntry) {
            firstEntry = entry
            resolveFirst(entry)
          }
          return entry.result
        } catch (err) {
          if (entry.controller.signal.aborted || entry.status === 'cancelled') {
            entry.status = 'cancelled'
            updateCandidate(slotCandidate.id, { status: 'failed', error: '超过赛马等待上限，已取消' })
            return null
          }
          const message = (err as Error).message || '生成失败'
          entry.status = 'failed'
          entry.failureMessage = message
          updateCandidate(slotCandidate.id, { status: 'failed', error: message })
          emit(runId, 'candidate', { id: slotCandidate.id, status: 'failed', variant: index, error: message })
          return null
        } finally {
          settled += 1
          if (settled === entries.length) resolveAllDone()
        }
      })()
      return task
    })

    const first = await Promise.race([firstReady, allDone.then(() => null)])
    if (!first) {
      const failure = entries.map((entry) => entry.failureMessage).find(Boolean)
      throw new Error(failure || '所有候选均生成失败，请重试或继续修改')
    }

    emitStep(
      runId,
      'generate',
      'running',
      `候选${String.fromCharCode(65 + first.index)} 已就绪，先预览并实测；其余候选等待中…`,
    )
    emitStep(runId, 'verify', 'running', '首候选实测中，等待其余候选…')

    const firstScored = await first.scoredPromise!
    const lowScore = firstScored.totalScore < 70
    const graceMs = lowScore ? config.raceLowScoreGraceMs : config.raceGraceMs
    const deadlineAt = (first.readyAt || Date.now()) + graceMs
    emit(runId, 'race', {
      firstCandidateId: first.candidate.id,
      firstScore: firstScored.totalScore,
      graceMs,
      extended: lowScore,
      deadlineAt,
    })

    const hasGenerating = entries.some((entry) => entry.status === 'generating')
    if (hasGenerating) {
      const outcome = await Promise.race([
        allDone.then(() => 'done' as const),
        sleep(deadlineAt - Date.now()).then(() => 'timeout' as const),
      ])
      if (outcome === 'timeout') {
        for (const entry of entries) {
          if (entry.status !== 'generating') continue
          entry.status = 'cancelled'
          cancelReportWait(entry.candidate.id)
          try {
            entry.controller.abort()
          } catch {
            /* noop */
          }
        }
        // 取消 fetch 后通常立即 settle；最多再等 3s，避免异常 provider 拖住整个 run
        await Promise.race([allDone, sleep(3000)])
      }
    }
    await Promise.race([allDone, sleep(3000)])

    const readyResults = entries.map((entry) => entry.result).filter((item): item is CandidateResult => Boolean(item))
    if (readyResults.length === 0) throw new Error('所有候选均生成失败，请重试或继续修改')
    const skipped = entries
      .filter((entry) => entry.status === 'cancelled')
      .map((entry) => ({
        id: entry.candidate.id,
        model: entry.result?.generated.model || entry.candidate.model,
        reason: 'grace-timeout',
        graceMs,
      }))
    for (const item of skipped) {
      emit(runId, 'candidate_timeout', item)
    }

    const scored = (await Promise.all(
      entries
        .filter((entry) => entry.result && entry.scoredPromise)
        .map((entry) => entry.scoredPromise!),
    )).filter((item): item is ScoredCandidate => Boolean(item))
    if (scored.length === 0) throw new Error('所有候选均未完成验收，请重试或继续修改')

    emitStep(
      runId,
      'generate',
      'done',
      `${
        raceCount > 1 ? `赛马：${scored.length} 路候选完成，` : ''
      }${scored
        .map(
          (item) =>
            `${item.generated.source === 'model' ? '模型' : '模板'} ${Math.round((item.generated.html.length / 1024) * 10) / 10}KB`,
        )
        .join(' · ')}${skipped.length ? `；${skipped.length} 路超过 ${Math.round(graceMs / 1000)}s 上限已取消` : ''}`,
    )
    emit(runId, 'candidates', {
      candidates: scored.map((item) => ({
        id: item.candidate.id,
        variant: item.index,
        model: item.generated.model,
        source: item.generated.source,
        staticScore: item.staticResult.score,
        durationMs: item.generated.durationMs,
      })),
      skipped,
    })
    emitStep(
      runId,
      'verify',
      'done',
      scored.some((item) => item.metrics)
        ? `收到 ${scored.filter((item) => item.metrics).length}/${scored.length} 份实测数据`
        : '未收到实测数据，按 0 分继续',
    )
    emitStep(runId, 'review', 'running')

    const sourceRank = (item: ScoredCandidate): number =>
      item.generated.source === 'model' ? 2 : item.generated.source === 'fallback' ? 0 : 1
    const winner = [...scored].sort(
      (a, b) =>
        sourceRank(b) - sourceRank(a) ||
        b.totalScore - a.totalScore ||
        b.staticResult.score - a.staticResult.score ||
        a.generated.durationMs - b.generated.durationMs,
    )[0]
    const race = scored.map((item) => ({
      id: item.candidate.id,
      label: `候选${String.fromCharCode(65 + item.index)}`,
      model: item.generated.model,
      source: item.generated.source,
      score: item.totalScore,
      parts: item.report.parts,
      durationMs: item.generated.durationMs,
      adopted: item.candidate.id === winner.candidate.id,
    }))
    scored.forEach((item) => {
      updateCandidate(item.candidate.id, { score: item.totalScore, report_json: JSON.stringify(item.report) })
    })
    const skipNotes = skipped.map((item) => {
      const label = `候选${String.fromCharCode(65 + entries.findIndex((entry) => entry.candidate.id === item.id))}`
      return `${label}（${item.model}）超过 ${Math.round(graceMs / 1000)}s 等待上限，已取消`
    })
    const reportNotes = [...winner.generated.notes, ...skipNotes]
    const fallbackWinner = winner.generated.source === 'fallback'
    const baseReport = { ...winner.report, notes: reportNotes, race, skipped, fallback: fallbackWinner }
    const winnerLabel = race.find((r) => r.adopted)?.label || '候选A'
    emitStep(
      runId,
      'review',
      'done',
      `${raceCount > 1 ? `${race.map((r) => `${r.label} ${r.score}`).join(' / ')}，择优采用 ${winnerLabel}` : `${winner.totalScore} 分`}，清单通过 ${winner.review.items.filter((i) => i.pass).length}/${winner.review.items.length}`,
    )

    const generated = winner.generated
    const source =
      generated.source === 'model' ? (run.mode === 'create' ? 'generate' : 'edit') : generated.source === 'fallback' ? 'fallback' : 'mock'
    if (isStopped(runId)) return
    const version = createVersion({
      projectId: project.id,
      html: generated.html,
      model: generated.model,
      source,
      score: winner.totalScore,
      report: baseReport,
    })
    touchProject(project.id, { current_version_id: version.id })
    const qaEnabled = config.qaEnabled && uiRuns.has(runId)
    emit(runId, 'version', {
      versionId: version.id,
      seq: version.seq,
      score: winner.totalScore,
      candidateId: winner.candidate.id,
      model: generated.model,
      source,
      adopted: true,
      qa: qaEnabled,
      mode: run.mode,
      skipped,
    })

    // QA 只对最终胜者执行，在隐藏沙箱完成；不阻塞版本保存与预览
    let qa: QaReport | null = null
    let acceptance: ReturnType<typeof buildAcceptance> | null = null
    let finalScore = winner.totalScore
    let finalParts = { ...baseReport.parts }
    let qaReport: QaReport | null = null
    if (qaEnabled) {
      emitStep(runId, 'qa', 'running', '在隐藏沙箱扫描实际功能并执行确定性用例…')
      qa = await waitForQa(runId, config.qaTimeoutMs)
      // QA 期间用户发起新编辑：旧 run 已停止，不再写报告/版本分数
      if (isStopped(runId)) return
      if (qa) {
        const repairRounds = countFixRunsSinceBase(project.id)
        acceptance = buildAcceptance(winner.checklist || checklist, qa, repairRounds)
        finalParts = { ...finalParts, checklist: acceptance.score }
        finalScore = winner.staticResult.score + winner.probe.score + acceptance.score
        qaReport = {
          ...qa,
          repairRounds,
          maxRepairRounds: acceptance.maxRepairRounds,
          blocked: acceptance.blocked,
        }
        emitStep(
          runId,
          'qa',
          acceptance.coreFailed || qa.failed > 0 ? 'failed' : 'done',
          `QA ${qa.passed}/${qa.total} 通过${qa.failed ? `，失败 ${qa.failed} 条` : ''}${
            acceptance.coreFailed ? '；核心需求未通过' : ''
          }`,
        )
      } else {
        emitStep(runId, 'qa', 'failed', '未收到 QA 结果（超时或沙箱未连接），已按探针与清单判定')
      }
    }
    const qaFailed = qa?.failed || 0
    const coreFailed = Boolean(acceptance?.coreFailed)
    const blocked = Boolean(acceptance?.blocked)
    const passed = finalScore >= 70 && !coreFailed && qaFailed === 0 && !blocked
    const needsFix = qaFailed > 0 || coreFailed || finalScore < 70
    const finalReport = {
      ...baseReport,
      score: finalScore,
      parts: finalParts,
      qa: qaReport,
      acceptance,
      needsFix,
      blocked,
      checklist: acceptance
        ? acceptance.items.map((item) => ({
            id: item.id,
            text: item.text,
            pass: item.status === 'passed',
            evidence: item.evidence,
          }))
        : baseReport.checklist,
    }
    updateVersion(version.id, { score: finalScore, report_json: JSON.stringify(finalReport) })
    updateCandidate(winner.candidate.id, { score: finalScore, report_json: JSON.stringify(finalReport) })
    emit(runId, 'report', finalReport)

    const passCount = acceptance
      ? acceptance.items.filter((i) => i.status === 'passed').length
      : winner.review.items.filter((i) => i.pass).length
    const totalItems = acceptance ? acceptance.items.length : winner.review.items.length
    const qaLine = qa ? `QA 测试：${qa.passed}/${qa.total} 通过${qa.failed ? `，失败 ${qa.failed} 条` : ''}。` : ''
    const raceLine =
      raceCount > 1
        ? `双路赛马：${race.map((r) => `${r.label} ${r.score} 分${r.adopted ? '（采用）' : ''}`).join('，')}。`
        : ''
    const skipLine = skipNotes.length ? `慢候选处理：${skipNotes.join('；')}。` : ''
    addMessage({
      projectId: project.id,
      role: 'agent',
      kind: 'report',
      content: [
        raceLine,
        skipLine,
        qaLine,
        reportSummary(finalScore, finalParts, passCount, totalItems, reportNotes),
      ]
        .filter(Boolean)
        .join('\n'),
      meta: finalReport,
    })
    addMessage({
      projectId: project.id,
      role: 'agent',
      kind: 'version',
      content: `已生成版本 v${version.seq}${fallbackWinner ? '（演示兜底模板）' : ''}`,
      meta: {
        versionId: version.id,
        seq: version.seq,
        score: finalScore,
        model: generated.model,
        candidateId: winner.candidate.id,
        source,
        adopted: true,
      },
    })

    emitStep(runId, 'deliver', 'running')
    const fallbackNote = fallbackWinner
      ? '演示兜底：模型未能生成可用页面，已使用内置模板；内容与原始需求可能不完全一致，建议重试。'
      : ''
    const blockedNote = blocked
      ? '核心需求在两轮修复后仍未实现，本次生成失败，不自动发布；可手动继续编辑或新建项目。'
      : ''
    const qaNote = qaFailed > 0 && !blocked ? `QA 有 ${qaFailed} 条失败，可一键修复复测（最多 2 轮）。` : ''
    const conclusion = [
      fallbackNote,
      `已采用 v${version.seq}（${finalScore} 分，${generated.model}）${raceCount > 1 ? `，从 ${race.length} 个候选中择优` : ''}。`,
      skipNotes.length ? `${skipNotes.join('；')}。` : '',
      blockedNote,
      qaNote,
      passed ? '验收通过，可直接预览、发布或继续迭代。' : blocked ? '' : '验收未通过，已保留该版本，建议按 QA/验收报告修复后继续。',
      winner.metrics ? '' : '（本次未收到浏览器实测，分数仅由静态检查与清单估算）',
    ]
      .filter(Boolean)
      .join('')
    addMessage({
      projectId: project.id,
      role: 'agent',
      kind: 'conclusion',
      content: conclusion,
      meta: {
        score: finalScore,
        adopted: true,
        status: passed ? 'passed' : 'needs-fix',
        versionSeq: version.seq,
        fallback: generated.source !== 'model',
        blocked,
      },
    })
    emit(runId, 'conclusion', {
      score: finalScore,
      adopted: true,
      status: passed ? 'passed' : 'needs-fix',
      versionSeq: version.seq,
      content: conclusion,
      blocked,
    })
    emitStep(runId, 'deliver', 'done', `v${version.seq} 已保存`)

    // 停止竞态：收尾阶段被停止时保持 stopped，不写 done
    if (isStopped(runId)) return
    updateRun(runId, {
      status: blocked ? 'failed' : 'done',
      error: blocked ? '核心需求在两轮修复后仍未实现' : null,
      finished_at: new Date().toISOString(),
    })
    emit(runId, 'done', {
      runId,
      status: blocked ? 'failed' : 'done',
      score: finalScore,
      versionSeq: version.seq,
      candidateId: winner.candidate.id,
      model: generated.model,
      skipped,
      blocked,
      qaFailed,
    })
  } catch (err) {
    const message = (err as Error).message || '未知错误'
    await finishWithFailure(runId, project.id, message)
  } finally {
    stoppedRuns.delete(runId)
    runControllers.delete(runId)
    uiRuns.delete(runId)
    const qa = pendingQa.get(runId)
    if (qa) {
      clearTimeout(qa.timer)
      pendingQa.delete(runId)
      qa.resolve(null)
    }
    for (const candidateId of cleanupCandidateIds) {
      cancelReportWait(candidateId)
      receivedReports.delete(candidateId)
    }
  }
}
