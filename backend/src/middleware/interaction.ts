import type { MiddlewareHandler } from 'hono'
import { sqlite } from '../db/index.js'
import { createRun, finishRun, inRun } from '../services/ai-runs.js'

/** Group automatic prompt generation and its submitted media task into one operation. */
export const interactionMiddleware: MiddlewareHandler = async (c, next) => {
  const path = c.req.path.replace(/^\/api\/v1/, '')
  const asset = path.match(/^\/(characters|scenes|props)\/(\d+)\/generate-(image|prompt)$/)
  const batch = path === '/characters/batch-generate-images'
  if (c.req.method !== 'POST' || (!asset && !batch && path !== '/tasks')) return next()
  const body = await c.req.json().catch(() => ({}))
  const episodeId = Number(body.episode_id) || undefined
  const ep = episodeId ? sqlite.prepare('SELECT drama_id FROM episodes WHERE id=?').get(episodeId) as any : undefined
  const sb = body.storyboard_id ? sqlite.prepare('SELECT episode_id FROM storyboards WHERE id=?').get(body.storyboard_id) as any : undefined
  const sbEp = sb ? sqlite.prepare('SELECT drama_id FROM episodes WHERE id=?').get(sb.episode_id) as any : undefined
  const runId = createRun({ service_type: asset?.[3] === 'prompt' ? 'text' : ['image', 'video'].includes(body.type) ? body.type : 'image', source: asset ? `${asset[1]}-${asset[3]}` : batch ? 'batch-images' : 'generate-media',
    drama_id: body.drama_id || ep?.drama_id || sbEp?.drama_id, episode_id: episodeId || sb?.episode_id, target_id: asset ? Number(asset[2]) : body.storyboard_id })
  try {
    await inRun(runId, next)
    const response = await c.res.clone().json().catch(() => null)
    finishRun(runId, c.res.status >= 400 ? response?.message || `HTTP ${c.res.status}` : undefined)
    if (response) {
      response.run_id = runId
      if (response.data && typeof response.data === 'object' && !Array.isArray(response.data)) response.data.run_id = runId
      c.res = new Response(JSON.stringify(response), { status: c.res.status, headers: c.res.headers })
    }
  } catch (error) { finishRun(runId, error); throw error }
}
