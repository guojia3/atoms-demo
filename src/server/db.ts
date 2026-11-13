// SQLite（Node 内置 node:sqlite，无需原生编译），WAL 模式；单机单进程足够
import { DatabaseSync } from 'node:sqlite'
import { config, ensureDataDir } from './config.js'

ensureDataDir()
const db = new DatabaseSync(config.databasePath)
db.exec('PRAGMA journal_mode = WAL;')
db.exec('PRAGMA foreign_keys = ON;')
db.exec('PRAGMA busy_timeout = 5000;')

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL DEFAULT 'guest',
  email TEXT UNIQUE,
  name TEXT,
  password_hash TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  prompt TEXT NOT NULL DEFAULT '',
  plan_json TEXT,
  checklist_json TEXT,
  current_version_id TEXT,
  published_version_id TEXT,
  share_slug TEXT UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_projects_user ON projects(user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS versions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  html TEXT NOT NULL,
  model TEXT,
  source TEXT NOT NULL DEFAULT 'generate',
  score INTEGER,
  report_json TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(project_id, seq)
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'text',
  content TEXT NOT NULL,
  meta_json TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_project ON messages(project_id, created_at);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  mode TEXT NOT NULL DEFAULT 'create',
  status TEXT NOT NULL DEFAULT 'running',
  instruction TEXT NOT NULL DEFAULT '',
  base_version_id TEXT,
  models_json TEXT,
  error TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_runs_project ON runs(project_id, started_at DESC);

CREATE TABLE IF NOT EXISTS candidates (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  model TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',
  html TEXT,
  error TEXT,
  duration_ms INTEGER,
  score INTEGER,
  report_json TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_candidates_run ON candidates(run_id);

CREATE TABLE IF NOT EXISTS app_data (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  scope TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, scope, key)
);
`)

export interface UserRow {
  id: string
  kind: 'guest' | 'email'
  email: string | null
  name: string | null
  password_hash: string | null
  created_at: string
}

export interface ProjectRow {
  id: string
  user_id: string
  title: string
  prompt: string
  plan_json: string | null
  checklist_json: string | null
  current_version_id: string | null
  published_version_id: string | null
  share_slug: string | null
  created_at: string
  updated_at: string
}

export interface VersionRow {
  id: string
  project_id: string
  seq: number
  html: string
  model: string | null
  source: string
  score: number | null
  report_json: string | null
  created_at: string
}

export interface MessageRow {
  id: string
  project_id: string
  role: string
  kind: string
  content: string
  meta_json: string | null
  created_at: string
}

export interface RunRow {
  id: string
  project_id: string
  mode: string
  status: string
  instruction: string
  base_version_id: string | null
  models_json: string | null
  error: string | null
  started_at: string
  finished_at: string | null
}

export interface CandidateRow {
  id: string
  run_id: string
  model: string
  status: string
  html: string | null
  error: string | null
  duration_ms: number | null
  score: number | null
  report_json: string | null
  created_at: string
}

export function now(): string {
  return new Date().toISOString()
}

export function getOne<T>(sql: string, ...params: unknown[]): T | undefined {
  return db.prepare(sql).get(...(params as never[])) as T | undefined
}

export function getAll<T>(sql: string, ...params: unknown[]): T[] {
  return db.prepare(sql).all(...(params as never[])) as T[]
}

export function run(sql: string, ...params: unknown[]): { changes: number; lastInsertRowid: number | bigint } {
  return db.prepare(sql).run(...(params as never[])) as { changes: number; lastInsertRowid: number | bigint }
}

export function exec(sql: string): void {
  db.exec(sql)
}

export function transaction<T>(fn: () => T): T {
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = fn()
    db.exec('COMMIT')
    return result
  } catch (err) {
    try {
      db.exec('ROLLBACK')
    } catch {
      /* noop */
    }
    throw err
  }
}

export default db
