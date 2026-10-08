import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { Hono } from 'hono'

const directory = await mkdtemp(path.join(tmpdir(), 'huobao-model-test-'))
process.env.SQLITE_PATH = path.join(directory, 'db.sqlite3')
process.env.HUOBAO_DATA_DIR = directory
process.env.WORKSPACE_PATH = path.join(directory, 'workspace')
const { sqlite } = await import('../src/db/index.js')
const { executeAgent } = await import('../src/agents/executor.js')
const { buildAgentRequestContext } = await import('../src/agents/context.js')
const { startExtraction, getExtractionStatus } = await import('../src/services/extraction.js')
const { ensureCharacterFinalPrompt } = await import('../src/services/final-prompt.js')
const { startVideoPromptBatch, getVideoPromptBatchStatus } = await import('../src/services/video-prompts.js')
const { generateImage, generateVideo } = await import('../src/services/generation.js')
const { eventsForRun, getRun, taskRunId } = await import('../src/services/ai-runs.js')
const { default: agentRoute } = await import('../src/routes/agent.js')
const { default: taskRoute } = await import('../src/routes/tasks.js')
const { interactionMiddleware } = await import('../src/middleware/interaction.js')
const { setContentLanguage } = await import('../src/services/app-settings.js')
const requests: { url: string; body: any }[] = []
const imageBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j8XQAAAAASUVORK5CYII=', 'base64')
let origin = '', imagePolls = 0, videoPolls = 0
const server = createServer(async (req, res) => {
  const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk))
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null
  const url = req.url!; requests.push({ url, body })
  function json(data: any) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(data)) }
  function sse(data: any[]) { res.setHeader('content-type', 'text/event-stream'); res.end(data.map(d => `data: ${JSON.stringify(d)}\n\n`).join('') + 'data: [DONE]\n\n') }
  if (/generateContent/i.test(url)) {
    sse([{ candidates: [{ index: 0, content: { role: 'model', parts: [{ text: '模型输出完整保存' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 3, totalTokenCount: 10 } }]); return
  }
  if (url.includes('chat/completions')) {
    const model = body.model, count = body.messages.filter((m: any) => m.role === 'tool').length
    const stages: Record<string, [string, any][]> = {
      chat: [['read_episode_script', {}], ['save_script', { content: '## S1 | 内景 · 书房 | 日\n小林：模型交互可以回看了。' }]],
      extraction: [['read_script_for_extraction', {}], ['save_dedup_characters', { characters: [{ name: '小林', appearance: '青年', styling: '蓝色衣服' }] }]],
      prompt: [['read_characters', {}], ['save_character_final_prompt', { character_id: 1, prompt: '青年小林三视图，正面、侧面、背面。' }]],
      'video-prompts': [['read_storyboard_context', {}], ['update_storyboard', { storyboard_id: 1, video_prompt: '@小林 @书房\n0-3秒 小林走进书房。' }]],
    }
    const step = stages[model]?.[count]
    const delta: any = { role: 'assistant' }
    if (step) {
      const normalize = (v: string) => v.replaceAll('_', '').toLowerCase()
      const tool = body.tools.find((tool: any) => normalize(tool.function.name) === normalize(step[0]))
      if (!tool) { res.statusCode = 400; json({ error: { message: `Tool missing: ${step[0]}` } }); return }
      delta.tool_calls = [{ index: 0, id: `call-${count}`, type: 'function', function: { name: tool.function.name, arguments: JSON.stringify(step[1]) } }]
    } else delta.content = '模型输出完整保存'
    sse([{ id: 'mock', object: 'chat.completion.chunk', created: 1, model, choices: [{ index: 0, delta, finish_reason: null }] },
      { id: 'mock', object: 'chat.completion.chunk', created: 1, model, choices: [{ index: 0, delta: {}, finish_reason: step ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } }]); return
  }
  if (url.endsWith('/images/generations')) { json(body.model === 'async-image' ? { task_id: 'mock-image' } : { data: [{ b64_json: imageBytes.toString('base64') }] }); return }
  if (url.includes('mock-image')) { json(++imagePolls === 1 ? { status: 'processing' } : { status: 'succeeded', data: [{ url: origin + '/image.png' }] }); return }
  if (url === '/api/v3/contents/generations/tasks') { json({ id: 'mock-video' }); return }
  if (url.endsWith('/mock-video')) { json(++videoPolls === 1 ? { status: 'running' } : { status: 'succeeded', content: { video_url: origin + '/video.mp4' } }); return }
  if (url === '/image.png' || url === '/video.mp4') { res.setHeader('content-type', url.endsWith('.png') ? 'image/png' : 'video/mp4'); res.end(imageBytes); return }
  res.statusCode = 404; json({ error: 'Unknown mock endpoint' })
})
server.listen(0, '127.0.0.1'); await once(server, 'listening')
origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); sqlite.close(); await rm(directory, { recursive: true, force: true }) })
sqlite.prepare("INSERT INTO dramas(id,title,created_at,updated_at) VALUES(1,'isolated test','now','now')").run()
sqlite.prepare("INSERT INTO episodes(id,drama_id,episode_number,title,content,created_at,updated_at) VALUES(1,1,1,'test','小林走进书房。','now','now')").run()
sqlite.prepare("INSERT INTO storyboards(id,episode_id,storyboard_number,title,description,created_at,updated_at) VALUES(1,1,1,'书房','【镜头1】小林进入书房。','now','now')").run()
function config(type: string, provider: string, model: string) {
  return Number(sqlite.prepare(`INSERT INTO ai_service_configs(service_type,provider,name,base_url,api_key,model,is_active,priority,created_at,updated_at)
    VALUES(?,?,?,?,?,?,1,1,'now','now')`).run(type, provider, 'mock', origin, 'secret-test-key', JSON.stringify([model])).lastInsertRowid)
}
const textConfig = config('text', 'openai', 'chat')
const rc = (configId = textConfig) => buildAgentRequestContext({ episodeId: 1, dramaId: 1, textConfigId: configId, language: 'ja' })
async function waitUntil(check: () => boolean, timeout = 10000) {
  const deadline = Date.now() + timeout
  while (!check()) { if (Date.now() >= deadline) throw new Error('Timed out waiting for saved business result'); await new Promise(resolve => setTimeout(resolve, 25)) }
}
function verify(id: string, provider = 'openai') {
  const run = getRun(id)!, events = eventsForRun(id, 0, 500)
  assert.equal(run.status, 'completed'); assert.equal(run.provider, provider)
  assert.ok(events.some(e => e.type === 'model-request'))
  assert.ok(events.some(e => e.type === 'model-response'))
  assert.ok(events.some(e => e.type === 'model-output'))
  assert.ok(events.some(e => e.type === 'usage'))
  assert.doesNotMatch(JSON.stringify(events), /secret-test-key/)
  return events
}

test('four production text entrances record actual model/tool messages and save business results', async () => {
  setContentLanguage('ja')
  const response = await new Hono().route('/agent', agentRoute).request('/agent/script_rewriter/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ drama_id: 1, episode_id: 1, config_id: textConfig, message: '改写并保存' }) })
  assert.equal(response.status, 200)
  const chat = (await response.json() as any).data
  const events = verify(chat.run_id)
  assert.equal(events.filter(e => e.type === 'tool-start').length, 2)
  assert.ok(events.some(e => e.type === 'tool-end' && JSON.stringify(e.data).includes('Script saved')))
  assert.match((sqlite.prepare('SELECT script_content FROM episodes WHERE id=1').get() as any).script_content, /小林/)
  assert.ok(requests.find(r => r.body?.model === 'chat')!.body.messages.some((m: any) => m.role === 'system' && m.content.includes('日本語')))
  startExtraction(1, 1, 'characters', { configId: textConfig, model: 'extraction' })
  await waitUntil(() => getExtractionStatus(1).characters?.status !== 'running')
  assert.equal(getExtractionStatus(1).characters?.status, 'done')
  verify(getExtractionStatus(1).characters!.run_id)
  const char = sqlite.prepare('SELECT * FROM characters WHERE id=1').get() as any
  assert.equal(char.name, '小林')
  const { db, schema } = await import('../src/db/index.js')
  const [character] = await db.select().from(schema.characters)
  const prompt = await ensureCharacterFinalPrompt(character, 1, true, { configId: textConfig, model: 'prompt' })
  assert.match(prompt, /三视图/)
  const promptRun = sqlite.prepare("SELECT id FROM ai_runs WHERE model='prompt'").get() as any; verify(promptRun.id)
  const batch = await startVideoPromptBatch(1, 1, { configId: textConfig, model: 'video-prompts' })
  await waitUntil(() => getVideoPromptBatchStatus(1)?.status !== 'running')
  assert.equal(getVideoPromptBatchStatus(1)?.completed, 1)
  assert.match((sqlite.prepare('SELECT video_prompt FROM storyboards WHERE id=1').get() as any).video_prompt, /@小林/)
  assert.equal(getRun(batch.run_id!)?.status, 'completed')
  const child = sqlite.prepare('SELECT id FROM ai_runs WHERE parent_id=?').get(batch.run_id) as any; verify(child.id)
})

test('Gemini and VolcEngine retain their provider/model and final request settings', async () => {
  for (const provider of ['gemini', 'volcengine']) {
    const id = config('text', provider, 'simple')
    sqlite.prepare('UPDATE ai_service_configs SET settings=? WHERE id=?').run(JSON.stringify({ temperature: 0 }), id)
    const result = await executeAgent('script_rewriter', [{ role: 'user', content: '回复一句话' }], { requestContext: rc(id), maxSteps: 1 })
    const events = verify(result.run_id, provider)
    assert.equal(result.text, '模型输出完整保存')
    const request = events.find(e => e.type === 'model-request')!.data
    assert.equal(provider === 'gemini' ? request.body.generationConfig.temperature : request.body.temperature, 0)
  }
})

test('image submit/base64 and image/video polling traces match downloaded assets and database results', { timeout: 45000 }, async () => {
  const syncId = config('image', 'openai', 'gpt-image-2')
  const asyncId = config('image', 'volcengine', 'async-image')
  const videoId = config('video', 'volcengine', 'doubao-seedance-2-0-260128')
  const image = await generateImage({ dramaId: 1, storyboardId: 1, configId: syncId, prompt: '完整图片提示词' })
  const asyncImage = await generateImage({ dramaId: 1, storyboardId: 1, configId: asyncId, prompt: '异步图片提示词' })
  const video = await generateVideo({ dramaId: 1, storyboardId: 1, configId: videoId, prompt: '完整视频提示词' })
  await waitUntil(() => [image, asyncImage, video].every(id => getRun(taskRunId(id)!)?.status !== 'running'), 35000)
  for (const task of [image, asyncImage, video]) {
    const run = getRun(taskRunId(task)!)!, events = eventsForRun(run.id)
    assert.equal(run.status, 'completed')
    const record = sqlite.prepare('SELECT * FROM sys_task WHERE id=?').get(task) as any
    assert.equal(record.local_path, run.result_url)
    assert.ok((await readFile(path.join(directory, record.local_path))).length > 0)
    assert.ok(events.some(e => e.type === 'media-submit'))
    assert.ok(events.some(e => e.type === 'download-end'))
    assert.doesNotMatch(JSON.stringify(events), /iVBORw0KGgo|secret-test-key/)
  }
  assert.equal(imagePolls, 2); assert.equal(videoPolls, 2)
  const polls = eventsForRun(taskRunId(video)!).filter(e => e.type === 'model-request' && e.data.method === 'GET')
  assert.equal(polls.length, 2)
})

test('media execution responses link the parent operation to its persisted task and failures retain run_id', async () => {
  const configId = config('image', 'openai', 'gpt-image-2')
  const app = new Hono().use('*', interactionMiddleware).route('/tasks', taskRoute)
  const response = await app.request('/tasks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'image', drama_id: 1, episode_id: 1, storyboard_id: 1, config_id: configId, prompt: '最终提示词' }) })
  assert.equal(response.status, 201)
  const data = await response.json() as any
  assert.ok(data.run_id); assert.equal(data.data.run_id, data.run_id)
  await waitUntil(() => getRun(data.run_id)?.status !== 'running')
  const children = sqlite.prepare('SELECT * FROM ai_runs WHERE parent_id=?').all(data.run_id) as any[]
  assert.equal(children.length, 1); assert.ok(children[0].task_id)
  assert.equal(getRun(data.run_id)?.status, 'completed')
  const invalid = await app.request('/tasks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'unsupported', episode_id: 1 }) })
  assert.equal(invalid.status, 400)
  const failure = await invalid.json() as any
  assert.equal(getRun(failure.run_id)?.status, 'failed')
})
