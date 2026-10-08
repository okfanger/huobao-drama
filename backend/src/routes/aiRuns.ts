import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { sqlite } from '../db/index.js'
import { clearRuns, eventsForRun, getRun, type AIRun } from '../services/ai-runs.js'
import { success, badRequest, notFound } from '../utils/response.js'

const app = new Hono()
function integer(raw: string | undefined, fallback = 0): number {
  if (raw === undefined) return fallback
  const n = Number(raw)
  return Number.isSafeInteger(n) && n >= 0 ? n : -1
}

app.get('/', c => {
  const limit = Math.min(integer(c.req.query('limit'), 50), 100)
  const filters: string[] = ['parent_id IS NULL']
  const values: any[] = []
  for (const field of ['drama_id', 'episode_id']) {
    const raw = c.req.query(field)
    if (raw !== undefined) {
      const n = integer(raw)
      if (n <= 0) return badRequest(c, `Invalid ${field}`)
      filters.push(`${field}=?`); values.push(n)
    }
  }
  const taskId = c.req.query('task_id')
  if (taskId !== undefined) {
    const n = integer(taskId)
    if (n <= 0) return badRequest(c, 'Invalid task_id')
    filters.push(`id IN (WITH RECURSIVE ancestors(id,parent_id) AS (
      SELECT id,parent_id FROM ai_runs WHERE task_id=? UNION ALL
      SELECT r.id,r.parent_id FROM ai_runs r JOIN ancestors a ON r.id=a.parent_id) SELECT id FROM ancestors)`)
    values.push(n)
  }
  for (const field of ['service_type', 'status']) {
    const raw = c.req.query(field)
    if (raw) { filters.push(`${field}=?`); values.push(raw) }
  }
  const cursor = c.req.query('cursor')
  if (cursor) {
    const pivot = getRun(cursor)
    if (!pivot) return badRequest(c, 'Invalid cursor')
    filters.push('(started_at<? OR (started_at=? AND id<?))'); values.push(pivot.started_at, pivot.started_at, pivot.id)
  }
  if (limit <= 0) return badRequest(c, 'Invalid limit')
  const items = sqlite.prepare(`SELECT * FROM ai_runs WHERE ${filters.join(' AND ')} ORDER BY started_at DESC,id DESC LIMIT ?`).all(...values, limit) as AIRun[]
  const eventCursor = (sqlite.prepare('SELECT MAX(id) AS id FROM ai_run_events').get() as any).id || 0
  const summaries = items.map(run => ({ ...run, models: sqlite.prepare(`WITH RECURSIVE family(id) AS
    (SELECT ? UNION ALL SELECT r.id FROM ai_runs r JOIN family f ON r.parent_id=f.id)
    SELECT DISTINCT provider,model FROM ai_runs WHERE id IN (SELECT id FROM family) AND provider IS NOT NULL`).all(run.id) }))
  return success(c, { items: summaries, event_cursor: eventCursor, next_cursor: items.length === limit ? items.at(-1)?.id : null })
})

// Replay is DB-backed. Client disconnects never cancel model execution.
app.get('/stream', c => {
  const episodeId = integer(c.req.query('episode_id'))
  const after = integer(c.req.header('Last-Event-ID') || c.req.query('after_id'))
  if (episodeId <= 0 || after < 0) return badRequest(c, 'Invalid episode_id/after_id')
  c.header('Cache-Control', 'no-cache, no-transform')
  c.header('X-Accel-Buffering', 'no')
  return streamSSE(c, async stream => {
    let cursor = after
    let closed = false
    let heartbeat = Date.now()
    stream.onAbort(() => { closed = true })
    await stream.writeSSE({ event: 'heartbeat', data: '{}' })
    while (!closed) {
      const rows = sqlite.prepare(`SELECT e.* FROM ai_run_events e JOIN ai_runs r ON r.id=e.run_id
        WHERE r.episode_id=? AND e.id>? ORDER BY e.id LIMIT 200`).all(episodeId, cursor) as any[]
      for (const row of rows) {
        if (closed) break
        await stream.writeSSE({ id: String(row.id), event: 'interaction', data: JSON.stringify({ ...row, data: JSON.parse(row.data), run: getRun(row.run_id) }) })
        cursor = row.id
      }
      if (Date.now() - heartbeat > 15000) {
        await stream.writeSSE({ event: 'heartbeat', data: '{}' })
        heartbeat = Date.now()
      }
      if (rows.length < 200) await stream.sleep(250)
    }
  })
})

app.delete('/', c => {
  const episodeId = integer(c.req.query('episode_id'))
  if (episodeId <= 0) return badRequest(c, 'episode_id is required')
  return success(c, { deleted: clearRuns(undefined, episodeId) })
})

app.get('/:id/events', c => {
  const id = c.req.param('id')
  if (!getRun(id)) return notFound(c)
  const after = integer(c.req.query('after_id'))
  const limit = Math.min(integer(c.req.query('limit'), 200), 500)
  if (after < 0 || limit <= 0) return badRequest(c, 'Invalid cursor/limit')
  const items = eventsForRun(id, after, limit)
  return success(c, { items, next_cursor: items.length === limit ? items.at(-1)?.id : null })
})
app.get('/:id', c => {
  const run = getRun(c.req.param('id'))
  if (!run) return notFound(c)
  const children = sqlite.prepare(`WITH RECURSIVE family(id) AS (SELECT ? UNION ALL SELECT r.id FROM ai_runs r JOIN family f ON r.parent_id=f.id)
    SELECT * FROM ai_runs WHERE id IN (SELECT id FROM family) ORDER BY started_at`).all(run.id)
  return success(c, { ...run, children })
})
export default app
