// 运行事件总线：内存序号 + 订阅 + 断线回放（进程重启后靠 snapshot 对齐）
export interface RunEvent {
  seq: number
  type: string
  data: unknown
  at: string
}

type Listener = (event: RunEvent) => void

const logs = new Map<string, RunEvent[]>()
const counters = new Map<string, number>()
const listeners = new Map<string, Set<Listener>>()

const MAX_EVENTS = 400

export function emit(runId: string, type: string, data: unknown): RunEvent {
  const seq = (counters.get(runId) || 0) + 1
  counters.set(runId, seq)
  const event: RunEvent = { seq, type, data, at: new Date().toISOString() }
  const list = logs.get(runId) || []
  list.push(event)
  if (list.length > MAX_EVENTS) list.splice(0, list.length - MAX_EVENTS)
  logs.set(runId, list)
  const subs = listeners.get(runId)
  if (subs) {
    for (const fn of subs) {
      try {
        fn(event)
      } catch {
        /* noop */
      }
    }
  }
  return event
}

export function subscribe(runId: string, listener: Listener): () => void {
  let subs = listeners.get(runId)
  if (!subs) {
    subs = new Set()
    listeners.set(runId, subs)
  }
  subs.add(listener)
  return () => {
    subs!.delete(listener)
    if (subs!.size === 0) listeners.delete(runId)
  }
}

export function eventsSince(runId: string, fromSeq: number): RunEvent[] {
  const list = logs.get(runId) || []
  return list.filter((e) => e.seq > fromSeq)
}

export function lastSeq(runId: string): number {
  return counters.get(runId) || 0
}

export function clearRun(runId: string): void {
  logs.delete(runId)
  counters.delete(runId)
  listeners.delete(runId)
}
