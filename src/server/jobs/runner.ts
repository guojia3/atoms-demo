// 运行编排：规划 → 生成 → 静态检查 → 浏览器实测 → 清单验收 → 采用版本 → 结论
import { config, isMockMode } from '../config.js'
import { emit } from './hub.js'
import { createPlan, mockPlan, type Plan, type ChecklistItem } from '../agents/planner.js'
import { generateCandidate, type GeneratedCandidate } from '../agents/engineer.js'
import { reviewChecklist } from '../agents/reviewer.js'
import { staticCheck } from '../verify/static-check.js'
import { scoreProbe, type ProbeMetrics } from '../verify/score.js'
import {
  addMessage,
  createCandidate,
  createVersion,
  getCandidate,
  getProject,
  getRun,
  getVersion,
  touchProject,
  updateCandidate,
  updateRun,
} from '../store.js'

interface PendingReport {
  resolve: (metrics: ProbeMetrics | null) => void
  timer: ReturnType<typeof setTimeout>
}

const pendingReports = new Map<string, PendingReport>()
const receivedReports = new Map<string, ProbeMetrics>()
const stoppedRuns = new Set<string>()
const runControllers = new Map<string, Set<AbortController>>()

const STEP_LABELS: Record<string, string> = {
  plan: 'Mike 拆解需求',
  generate: 'Alex 生成页面',
  verify: '静态检查 + 浏览器实测',
  review: '逐条验收',
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
    const report = { ...winner.report, notes: reportNotes, race, skipped, fallback: fallbackWinner }
    updateCandidate(winner.candidate.id, { score: winner.totalScore, report_json: JSON.stringify(report) })
    emit(runId, 'report', report)
    const winnerLabel = race.find((r) => r.adopted)?.label || '候选A'
    const passCount = winner.review.items.filter((i) => i.pass).length
    emitStep(
      runId,
      'review',
      'done',
      `${raceCount > 1 ? `${race.map((r) => `${r.label} ${r.score}`).join(' / ')}，择优采用 ${winnerLabel}` : `${winner.totalScore} 分`}，清单通过 ${passCount}/${winner.review.items.length}`,
    )
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
        reportSummary(winner.totalScore, report.parts, passCount, winner.review.items.length, reportNotes),
      ]
        .filter(Boolean)
        .join('\n'),
      meta: report,
    })

    const generated = winner.generated
    const totalScore = winner.totalScore
    const metrics = winner.metrics

    if (isStopped(runId)) return

    // 4) 采用与结论
    emitStep(runId, 'deliver', 'running')
    const source =
      generated.source === 'model' ? (run.mode === 'create' ? 'generate' : 'edit') : generated.source === 'fallback' ? 'fallback' : 'mock'
    const version = createVersion({
      projectId: project.id,
      html: generated.html,
      model: generated.model,
      source,
      score: totalScore,
      report,
    })
    touchProject(project.id, { current_version_id: version.id })
    addMessage({
      projectId: project.id,
      role: 'agent',
      kind: 'version',
      content: `已生成版本 v${version.seq}${fallbackWinner ? '（演示兜底模板）' : ''}`,
      meta: {
        versionId: version.id,
        seq: version.seq,
        score: totalScore,
        model: generated.model,
        candidateId: winner.candidate.id,
        source,
        adopted: true,
      },
    })
    emit(runId, 'version', {
      versionId: version.id,
      seq: version.seq,
      score: totalScore,
      candidateId: winner.candidate.id,
      model: generated.model,
      source,
      adopted: true,
      skipped,
    })

    const passed = totalScore >= 70
    const fallbackNote = fallbackWinner
      ? '演示兜底：模型未能生成可用页面，已使用内置模板；内容与原始需求可能不完全一致，建议重试。'
      : ''
    const conclusion = [
      fallbackNote,
      `已采用 v${version.seq}（${totalScore} 分，${generated.model}）${raceCount > 1 ? `，从 ${race.length} 个候选中择优` : ''}。`,
      skipNotes.length ? `${skipNotes.join('；')}。` : '',
      passed ? '验收通过，可直接预览、发布或继续迭代。' : '总分低于 70，已保留该版本，建议按报告中的未通过项继续修改。',
      metrics ? '' : '（本次未收到浏览器实测，分数仅由静态检查与清单估算）',
    ]
      .filter(Boolean)
      .join('')
    addMessage({
      projectId: project.id,
      role: 'agent',
      kind: 'conclusion',
      content: conclusion,
      meta: { score: totalScore, adopted: true, status: passed ? 'passed' : 'needs-fix', versionSeq: version.seq, fallback: generated.source !== 'model' },
    })
    emit(runId, 'conclusion', {
      score: totalScore,
      adopted: true,
      status: passed ? 'passed' : 'needs-fix',
      versionSeq: version.seq,
      content: conclusion,
    })
    emitStep(runId, 'deliver', 'done', `v${version.seq} 已保存`)

    // 停止竞态：收尾阶段被停止时保持 stopped，不写 done
    if (isStopped(runId)) return
    updateRun(runId, { status: 'done', finished_at: new Date().toISOString() })
    emit(runId, 'done', {
      runId,
      status: 'done',
      score: totalScore,
      versionSeq: version.seq,
      candidateId: winner.candidate.id,
      model: generated.model,
      skipped,
    })
  } catch (err) {
    const message = (err as Error).message || '未知错误'
    await finishWithFailure(runId, project.id, message)
  } finally {
    stoppedRuns.delete(runId)
    runControllers.delete(runId)
    for (const candidateId of cleanupCandidateIds) {
      cancelReportWait(candidateId)
      receivedReports.delete(candidateId)
    }
  }
}
