import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { sqlite } from '../db/index.js'
import { interactionData } from './interaction-data.js'

export interface AIRun {
  id: string; parent_id: string | null; drama_id: number | null; episode_id: number | null
  task_id: number | null; target_id: number | null; service_type: string; source: string
  provider: string | null; model: string | null; status: string; started_at: string
  finished_at: string | null; error: string | null; result_url: string | null; completion_requested: string | null
}
export interface RunEvent { id: number; run_id: string; type: string; created_at: string; data: any }
const context = new AsyncLocalStorage<string>()
export const currentRunId = () => context.getStore()
export const inRun = <T>(id: string, fn: () => T): T => context.run(id, fn)
export const getRun = (id: string) => sqlite.prepare('SELECT * FROM ai_runs WHERE id=?').get(id) as AIRun | undefined

export function createRun(fields: Partial<AIRun> & Pick<AIRun, 'service_type' | 'source'>): string {
  const id = randomUUID()
  const parent = fields.parent_id ?? currentRunId() ?? null
  const inherited = parent ? getRun(parent) : undefined
  sqlite.prepare(`INSERT INTO ai_runs (id,parent_id,drama_id,episode_id,task_id,target_id,service_type,source,provider,model,started_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(id, parent, fields.drama_id ?? inherited?.drama_id ?? null,
    fields.episode_id ?? inherited?.episode_id ?? null, fields.task_id ?? null, fields.target_id ?? null,
    fields.service_type, fields.source, fields.provider ?? null, fields.model ?? null, new Date().toISOString())
  appendEvent(id, 'run-start', { source: fields.source, service_type: fields.service_type })
  return id
}

export function updateRun(id: string, fields: Partial<Pick<AIRun, 'provider' | 'model' | 'task_id' | 'result_url'>>): void {
  const entries = Object.entries(fields).filter(([, value]) => value !== undefined)
  if (!entries.length) return
  sqlite.prepare(`UPDATE ai_runs SET ${entries.map(([key]) => `${key}=?`).join(',')} WHERE id=?`).run(...entries.map(([, value]) => interactionData(value)), id)
}

export function appendEvent(id: string, type: string, data: unknown): number {
  const row = getRun(id)
  if (!row || row.status !== 'running') return 0
  return Number(sqlite.prepare('INSERT INTO ai_run_events (run_id,type,created_at,data) VALUES (?,?,?,?)')
    .run(id, type, new Date().toISOString(), JSON.stringify(interactionData(data) ?? null)).lastInsertRowid)
}
export function traceEvent(type: string, data: unknown): void {
  const id = currentRunId()
  if (id) appendEvent(id, type, data)
}

function finalize(id: string): void {
  const run = getRun(id)
  if (!run || run.status !== 'running' || !run.completion_requested) return
  const children = sqlite.prepare('SELECT status,error FROM ai_runs WHERE parent_id=?').all(id) as AIRun[]
  if (children.some(child => child.status === 'running')) return
  const failed = children.find(child => child.status !== 'completed')
  const status = run.completion_requested === 'failed' || failed ? 'failed' : 'completed'
  const error = run.error || failed?.error || null
  appendEvent(id, 'run-end', { status, error })
  sqlite.prepare('UPDATE ai_runs SET status=?,finished_at=?,error=? WHERE id=?').run(status, new Date().toISOString(), error, id)
  if (run.parent_id) finalize(run.parent_id)
}
export function finishRun(id: string, error?: unknown): void {
  const row = getRun(id)
  if (!row || row.status !== 'running') return
  if (error) appendEvent(id, 'error', interactionData(error))
  sqlite.prepare('UPDATE ai_runs SET completion_requested=?,error=? WHERE id=?').run(error || row.completion_requested === 'failed' ? 'failed' : 'completed', error ? String(interactionData(error instanceof Error ? error.message : error)) : row.error, id)
  finalize(id)
}

export function eventsForRun(id: string, afterId = 0, limit = 200): RunEvent[] {
  const rows = sqlite.prepare(`WITH RECURSIVE family(id) AS (SELECT id FROM ai_runs WHERE id=? UNION ALL SELECT r.id FROM ai_runs r JOIN family f ON r.parent_id=f.id)
    SELECT e.* FROM ai_run_events e WHERE e.run_id IN (SELECT id FROM family) AND e.id>? ORDER BY e.id LIMIT ?`).all(id, afterId, limit) as any[]
  return rows.map(row => ({ ...row, data: JSON.parse(row.data) }))
}
export function taskRunId(taskId: number): string | null {
  return (sqlite.prepare('SELECT id FROM ai_runs WHERE task_id=? ORDER BY started_at DESC LIMIT 1').get(taskId) as any)?.id ?? null
}

export function clearRuns(before?: string, episodeId?: number): number {
  // Only remove closed root families; active descendants are never removed.
  const roots = sqlite.prepare(`SELECT id FROM ai_runs WHERE parent_id IS NULL AND status!='running'
    ${before ? 'AND finished_at<?' : ''} ${episodeId ? 'AND episode_id=?' : ''}`).all(...[before, episodeId].filter(value => value !== undefined)) as { id: string }[]
  return sqlite.transaction(() => {
    for (const root of roots) {
      const ids = (sqlite.prepare(`WITH RECURSIVE family(id) AS (SELECT ? UNION ALL SELECT r.id FROM ai_runs r JOIN family f ON r.parent_id=f.id) SELECT id FROM family`).all(root.id) as { id: string }[]).map(row => row.id)
      for (const id of ids.reverse()) {
        sqlite.prepare('DELETE FROM ai_run_events WHERE run_id=?').run(id)
        sqlite.prepare('DELETE FROM ai_runs WHERE id=?').run(id)
      }
    }
    return roots.length
  })()
}
export function startRunMaintenance(): void {
  const interrupted = sqlite.prepare("SELECT id FROM ai_runs WHERE status='running'").all() as { id: string }[]
  for (const { id } of interrupted) {
    appendEvent(id, 'run-end', { status: 'interrupted', error: 'Application restarted' })
    sqlite.prepare("UPDATE ai_runs SET status='interrupted',finished_at=?,error=? WHERE id=?").run(new Date().toISOString(), 'Application restarted', id)
  }
  const clean = () => clearRuns(new Date(Date.now() - 30 * 86400000).toISOString())
  clean()
  setInterval(clean, 86400000).unref()
}

/** Coalesce output deltas without keeping a timer alive after completion. */
export function outputBuffer(id: string) {
  const pending = new Map<string, string>()
  let timer: ReturnType<typeof setTimeout> | undefined
  const flush = () => {
    if (timer) clearTimeout(timer)
    timer = undefined
    for (const [item_id, text] of pending) appendEvent(id, 'model-output', { item_id, text, delta: true })
    pending.clear()
  }
  return { push(itemId: string, text: string) {
    pending.set(itemId, (pending.get(itemId) || '') + text)
    if (!timer) timer = setTimeout(flush, 100)
  }, flush }
}
