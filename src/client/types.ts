export interface User {
  id: string
  kind: 'guest' | 'email'
  email: string | null
  name: string | null
}

export interface ChecklistItem {
  id: string
  text: string
}

export interface Plan {
  title: string
  summary: string
  views: string[]
  features: string[]
  design: string
  data: string
  checklist: ChecklistItem[]
  source?: string
  model?: string
  notes?: string
}

export interface VersionMeta {
  id: string
  seq: number
  source: string
  score: number | null
  model: string | null
  createdAt: string
}

export interface Message {
  id: string
  role: 'user' | 'agent' | 'system'
  kind: 'text' | 'plan' | 'report' | 'version' | 'conclusion' | string
  content: string
  meta: any
  createdAt: string
}

export interface ProjectDetail {
  id: string
  title: string
  prompt: string
  plan: Plan | null
  checklist: ChecklistItem[] | null
  currentVersionId: string | null
  publishedVersionId: string | null
  shareSlug: string | null
  createdAt: string
  updatedAt: string
  html: string
  versions: VersionMeta[]
  publishedVersionSeq: number | null
  messages: Message[]
  activeRunId: string | null
}

export interface ProjectSummary {
  id: string
  title: string
  prompt: string
  updatedAt: string
  versionCount: number
  score: number | null
  shareSlug: string | null
  published: boolean
}

export interface SampleSummary {
  id: string
  title: string
  prompt: string
  slug: string
  score: number | null
}

export interface ReportItem {
  key?: string
  id?: string
  label?: string
  text?: string
  score?: number
  max?: number
  pass?: boolean
  evidence: string
  detail?: string
}

export interface RaceCandidate {
  id: string
  label: string
  model: string
  source: string
  score: number
  parts: { static: number; probe: number; checklist: number }
  durationMs: number
  adopted: boolean
}

export interface Report {
  score: number
  parts: { static: number; probe: number; checklist: number }
  static?: { items: ReportItem[] }
  probe?: ReportItem[]
  checklist?: ReportItem[]
  metrics?: any
  notes?: string[]
  reviewSource?: string
  race?: RaceCandidate[]
}

export interface PickTarget {
  selector: string
  tag: string
  text: string
  html?: string
}

export interface RunSnapshot {
  run: { id: string; status: string; mode: string; instruction: string }
  project: ProjectDetail | null
}

export interface StepState {
  key: string
  label: string
  status: 'running' | 'done' | 'failed'
  detail?: string
}

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

export interface ConsoleEntry {
  id: string
  level: 'info' | 'error' | 'warn'
  text: string
  at: string
}

export interface ServerConfig {
  mock: boolean
  model: {
    configured: boolean
    primary: string | null
    providers: Array<{ name: string; model: string }>
  }
  probeTimeoutSec: number
}
