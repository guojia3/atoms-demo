// 工作台预览区阶段进度：首候选前居中完整阶段列表，首候选后收成顶部细条
import { useState } from 'react'
import type { StageItem, StageProgress, StageStatus } from '../../shared/stage-progress'

function statusColor(status: StageStatus): string {
  if (status === 'done') return 'text-ok'
  if (status === 'running') return 'text-brand'
  if (status === 'failed') return 'text-bad'
  if (status === 'skipped') return 'text-ink-faint'
  return 'text-ink-faint'
}

function StageIcon({ status, index, small = false }: { status: StageStatus; index: number; small?: boolean }) {
  const size = small ? 'h-3.5 w-3.5 text-[8px]' : 'h-5 w-5 text-[9px]'
  if (status === 'done') {
    return <span className={`grid shrink-0 place-items-center rounded-full border border-ok/30 bg-ok-soft ${size} text-ok`}>✓</span>
  }
  if (status === 'running') {
    return (
      <span className={`grid shrink-0 place-items-center rounded-full border border-brand/30 bg-brand-soft ${size} text-brand`}>
        <span className="h-1.5 w-1.5 animate-pulse-dot rounded-full bg-brand motion-reduce:animate-none" />
      </span>
    )
  }
  if (status === 'failed') {
    return <span className={`grid shrink-0 place-items-center rounded-full border border-bad/30 bg-bad-soft ${size} text-bad`}>!</span>
  }
  if (status === 'skipped') {
    return <span className={`grid shrink-0 place-items-center rounded-full border border-line bg-canvas ${size} text-ink-faint`}>–</span>
  }
  return <span className={`grid shrink-0 place-items-center rounded-full border border-line bg-white ${size} font-mono-ui text-ink-faint`}>{index + 1}</span>
}

function StageList({ progress, dense = false }: { progress: StageProgress; dense?: boolean }) {
  return (
    <ol
      className={
        dense
          ? 'grid grid-cols-1 gap-1.5 sm:grid-cols-2'
          : 'grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:items-center sm:gap-2.5'
      }
      aria-label="执行阶段"
    >
      {progress.stages.map((stage: StageItem, index: number) => {
        const current = stage.key === progress.currentKey
        return (
          <li
            key={stage.key}
            aria-current={current ? 'step' : undefined}
            title={`${stage.label}：${stage.statusLabel}`}
            className={[
              'flex min-w-0 items-center gap-2',
              dense
                ? 'rounded-lg border border-line/70 bg-canvas-soft/50 px-2.5 py-1.5'
                : 'rounded-lg border border-line/70 bg-canvas-soft/50 px-2.5 py-2 sm:border-0 sm:bg-transparent sm:px-0 sm:py-0',
              current && !dense ? 'border-brand-line/70 bg-brand-soft/40 sm:bg-transparent' : '',
            ].join(' ')}
          >
            <StageIcon status={stage.status} index={index} />
            <span className="min-w-0">
              <span className={['block truncate text-[11px]', current ? 'font-semibold text-ink' : 'text-ink-soft'].join(' ')}>
                {stage.label}
              </span>
              <span className={['block text-[9px] sm:hidden', statusColor(stage.status)].join(' ')}>{stage.statusLabel}</span>
              <span className="sr-only">{stage.statusLabel}</span>
            </span>
            {!dense && index < progress.stages.length - 1 && (
              <span className="hidden h-px w-3 shrink-0 bg-line sm:block" aria-hidden="true" />
            )}
          </li>
        )
      })}
    </ol>
  )
}

/** 首候选出现前：预览区中央的完整阶段列表 */
export function StageFullPanel({ progress }: { progress: StageProgress }) {
  return (
    <section
      className="w-full max-w-[660px] text-left"
      aria-label="执行阶段进度"
      data-stage-panel="full"
      data-stage-overall={progress.overall}
      data-stage-current={progress.currentKey}
      data-stage-summary={progress.summary}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-mono-ui text-[10px] tracking-[0.08em] text-ink-faint uppercase">执行阶段</span>
        <span className="font-mono-ui text-[10px] text-ink-muted" data-stage-summary-text>
          {progress.summary}
        </span>
      </div>
      <div className="mt-3">
        <StageList progress={progress} />
      </div>
      <p className="mt-3 text-[11px] leading-5 text-ink-muted" aria-live="polite">
        {progress.description}
      </p>
    </section>
  )
}

/** 首候选出现后：预览区顶部细条，点击展开六阶段详细状态 */
export function StageCompactBar({ progress }: { progress: StageProgress }) {
  const [open, setOpen] = useState(false)
  const pct = Math.round(((progress.currentIndex + 1) / progress.stages.length) * 100)
  const barColor = progress.overall === 'failed' ? 'bg-bad' : progress.overall === 'stopped' ? 'bg-ink-faint' : 'bg-brand'
  return (
    <div
      className="shrink-0 border-b border-line bg-white"
      data-stage-panel="compact"
      data-stage-overall={progress.overall}
      data-stage-current={progress.currentKey}
      data-stage-summary={progress.summary}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls="stage-progress-expanded"
        aria-label={`执行阶段进度，${progress.summary}`}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left sm:px-3"
      >
        <span className="shrink-0 font-mono-ui text-[9px] tracking-[0.08em] text-ink-faint uppercase">阶段</span>
        <span
          className="min-w-0 flex-1 truncate text-[10px] font-medium text-ink-soft sm:hidden"
          aria-current={progress.overall === 'running' ? 'step' : undefined}
        >
          {progress.summary}
        </span>
        <span className="hidden min-w-0 flex-1 items-center gap-1 overflow-hidden sm:flex">
          {progress.stages.map((stage, index) => {
            const current = stage.key === progress.currentKey
            return (
              <span key={stage.key} className="flex min-w-0 items-center gap-1">
                <span
                  aria-current={current ? 'step' : undefined}
                  title={`${stage.label}：${stage.statusLabel}`}
                  className={[
                    'flex min-w-0 items-center gap-1 rounded-full px-1 py-0.5',
                    current ? 'bg-brand-soft/60 text-brand' : statusColor(stage.status),
                  ].join(' ')}
                >
                  <StageIcon status={stage.status} index={index} small />
                  <span className={['max-w-[4.5rem] truncate text-[9px]', current ? 'font-semibold' : ''].join(' ')}>
                    {stage.label}
                  </span>
                  <span className="sr-only">{stage.statusLabel}</span>
                </span>
                {index < progress.stages.length - 1 && <span className="h-px w-1.5 shrink-0 bg-line" aria-hidden="true" />}
              </span>
            )
          })}
        </span>
        <span className="ml-auto shrink-0 text-[9px] text-ink-faint">{open ? '收起' : '详情'}</span>
      </button>
      <div className="h-0.5 bg-canvas" aria-hidden="true">
        <div
          className={['h-full transition-all duration-300 motion-reduce:transition-none', barColor].join(' ')}
          style={{ width: `${pct}%` }}
        />
      </div>
      {open && (
        <div id="stage-progress-expanded" className="border-t border-line bg-white px-3 py-2.5">
          <StageList progress={progress} dense />
          <p className="mt-2 text-[10px] leading-4 text-ink-muted" aria-live="polite">
            {progress.description}
          </p>
        </div>
      )}
    </div>
  )
}
