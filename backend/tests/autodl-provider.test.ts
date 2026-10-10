import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { Hono } from 'hono'

const directory = await mkdtemp(path.join(tmpdir(), 'huobao-autodl-test-'))
process.env.SQLITE_PATH = path.join(directory, 'db.sqlite3')
process.env.HUOBAO_DATA_DIR = directory
process.env.STORAGE_PATH = path.join(directory, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'
const { sqlite } = await import('../src/db/index.js')
const { isOfficialProvider, getTextProviderBaseUrl, getConfigById, getActiveConfig } = await import('../src/services/ai.js')
const { getAutoDLBaseUrl } = await import('../src/services/adapters/autodl.js')
const { getImageAdapter, getVideoAdapter } = await import('../src/services/adapters/registry.js')
const { default: configRoute } = await import('../src/routes/aiConfigs.js')
const { default: taskRoute } = await import('../src/routes/tasks.js')
const { generateImage } = await import('../src/services/generation.js')
const { executeAgent } = await import('../src/agents/executor.js')
const { buildAgentRequestContext } = await import('../src/agents/context.js')
const { getRun, taskRunId } = await import('../src/services/ai-runs.js')

const requests: { url: string; method?: string; authorization?: string; body: any }[] = []
const imageBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j8XQAAAAASUVORK5CYII=', 'base64')
const server = createServer(async (req, res) => {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.from(chunk))
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined
  requests.push({ url: req.url!, method: req.method, authorization: req.headers.authorization, body })
  res.setHeader('content-type', 'application/json')
  const json = (data: unknown) => res.end(JSON.stringify(data))
  if (req.url === '/api/v1/models') return json({ data: [{ id: 'DeepSeek-V4-Pro' }] })
  if (req.url === '/api/v1/images/generations') return json({ data: [{ b64_json: imageBytes.toString('base64') }] })
  if (req.url === '/api/v1/ali/api/v1/services/aigc/video-generation/video-synthesis') {
    return json({ output: { task_id: 'wan-task', task_status: 'PENDING' } })
  }
  if (req.url === '/api/v1/ali/api/v1/tasks/wan-task') {
    return json({ output: { task_status: 'FAILED', message: 'verified Wan polling route' } })
  }
  if (req.url === '/api/v1/chat/completions') {
    const hasToolResult = body.messages.some((message: any) => message.role === 'tool')
    const tool = body.tools.find((entry: any) => entry.function.name.replaceAll('_', '').toLowerCase() === 'savescript')
    assert.ok(tool, 'the real text agent must expose its save_script tool')
    const delta = hasToolResult ? { content: '剧本已保存' } : {
      role: 'assistant',
      tool_calls: [{ index: 0, id: 'save-script', type: 'function', function: {
        name: tool.function.name,
        arguments: JSON.stringify({ content: '## S1 | 内景 · 书房 | 日\n小林：AutoDL 文本接入成功。' }),
      } }],
    }
    res.setHeader('content-type', 'text/event-stream')
    return res.end([
      { id: 'mock', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason: null }] },
      { id: 'mock', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta: {}, finish_reason: hasToolResult ? 'stop' : 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
    ].map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n')
  }
  res.statusCode = 404
  json({ error: 'Unexpected AutoDL route' })
})
server.listen(0, '127.0.0.1')
await once(server, 'listening')
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
after(async () => {
  server.closeAllConnections()
  await new Promise<void>(resolve => server.close(() => resolve()))
  sqlite.close()
  await rm(directory, { recursive: true, force: true })
})

const app = new Hono().route('/ai-configs', configRoute).route('/tasks', taskRoute)
const config = { provider: 'autodl', baseUrl: 'https://www.autodl.art/api/v1', apiKey: 'test-token', model: 'doubao-seedance-2-0-mini-260615' }
const image = getImageAdapter('AutoDL')
const video = getVideoAdapter('AutoDL')
const configIds = new Map<string, number>()
const models = { text: 'DeepSeek-V4-Pro', image: 'Qwen-Image', video: config.model }

test('AutoDL registers all three services and normalizes the site/API roots', () => {
  for (const type of ['text', 'image', 'video']) assert.equal(isOfficialProvider(type, 'AutoDL'), true)
  assert.equal(isOfficialProvider('audio', 'autodl'), false)
  assert.equal(image.provider, 'autodl')
  assert.equal(video.provider, 'autodl')
  for (const baseUrl of ['', 'https://www.autodl.art', 'https://www.autodl.art/', config.baseUrl, config.baseUrl + '/']) {
    assert.equal(getAutoDLBaseUrl(baseUrl), config.baseUrl)
    assert.equal(getTextProviderBaseUrl({ ...config, baseUrl }), config.baseUrl)
  }
  assert.equal(getAutoDLBaseUrl('https://proxy.example/gateway/api/v1/'), 'https://proxy.example/gateway/api/v1')
})

test('AutoDL image requests use documented auth, native dimensions, and text-to-image fields', () => {
  const request = image.buildGenerateRequest(config, { id: 1, model: 'Qwen-Image', prompt: '一只猫', size: '1920x1080' })
  assert.equal(request.url, config.baseUrl + '/images/generations')
  assert.equal(request.headers.Authorization, 'test-token')
  assert.deepEqual(request.body, { model: 'Qwen-Image', prompt: '一只猫', size: '1664x928', n: 1 })
  for (const [size, expected] of [['1080x1920', '928x1664'], ['1024x1024', '1328x1328']]) {
    assert.equal(image.buildGenerateRequest({ ...config, model: 'Qwen-Image' }, { id: 2, size }).body.size, expected)
  }
  const z = image.buildGenerateRequest({ ...config, baseUrl: 'https://www.autodl.art/', model: 'Z-Image-Turbo' }, { id: 3, prompt: '一只猫' })
  assert.equal(z.url, request.url)
  assert.equal(z.body.size, '1024x1024')
  assert.throws(() => image.buildGenerateRequest(config, { id: 4, model: 'Qwen-Image', referenceImages: '["data:image/png;base64,aA=="]' }), /仅支持文生图/)
  assert.throws(() => image.buildGenerateRequest(config, { id: 5, model: 'unknown' }), /AutoDL 图片支持/)
  assert.deepEqual(image.parseGenerateResponse({ data: [{ url: 'https://example.com/image.png' }] }), { isAsync: false, imageUrl: 'https://example.com/image.png' })
  assert.deepEqual(image.extractImageBase64({ data: [{ b64_json: 'aA==' }] }), { data: 'aA==', mimeType: 'image/png' })
})

test('AutoDL video generation and polling keep each vendor protocol and gateway prefix', () => {
  const cases = [
    { model: config.model, generate: '/ark/v3/contents/generations/tasks', poll: '/ark/v3/contents/generations/tasks/task-123' },
    { model: 'wan3.0-video', generate: '/ali/api/v1/services/aigc/video-generation/video-synthesis', poll: '/ali/api/v1/tasks/task-123' },
    { model: 'wan3.0-video-prime', generate: '/ali/api/v1/services/aigc/video-generation/video-synthesis', poll: '/ali/api/v1/tasks/task-123' },
    { model: 'MiniMax-H3', generate: '/minimax/v2/video_generation', poll: '/minimax/v2/query/video_generation/task-123' },
  ]
  for (const entry of cases) {
    const actual = { ...config, model: entry.model }
    const request = video.buildGenerateRequest(actual, { id: 1, prompt: '走进房间', generateAudio: false, referenceImageUrls: '["https://example.com/ref.png"]' })
    assert.equal(request.url, config.baseUrl + entry.generate)
    assert.equal(request.method, 'POST')
    assert.equal(request.headers.Authorization, 'Bearer test-token')
    assert.equal(request.body.model, entry.model)
    if (entry.model.startsWith('wan')) {
      assert.equal(request.headers['X-DashScope-Async'], 'enable')
      assert.deepEqual(request.body.input.media, [{ type: 'reference_image', url: 'https://example.com/ref.png' }])
      assert.equal(request.body.parameters.audio, false)
    } else {
      assert.equal(request.body.content[1].role, 'reference_image')
    }
    const poll = video.buildPollRequest(actual, 'task-123')
    assert.equal(poll.url, config.baseUrl + entry.poll)
    assert.equal(poll.method, 'GET')
    assert.equal(poll.headers.Authorization, 'Bearer test-token')
    assert.equal(video.buildGenerateRequest({ ...actual, baseUrl: 'https://www.autodl.art/' }, { id: 2, prompt: '走进房间' }).url, request.url)
  }
  const override = video.buildGenerateRequest(config, { id: 3, model: 'MiniMax-H3', prompt: '走进房间' })
  assert.equal(override.url, config.baseUrl + '/minimax/v2/video_generation')
  assert.throws(() => video.buildGenerateRequest(config, { id: 4, model: 'kling-v3-omni', prompt: 'hello' }), /AutoDL 视频支持/)
  assert.equal(video.buildPollRequest({ ...config, model: 'wan3.0-video' }, 'a/b').url, config.baseUrl + '/ali/api/v1/tasks/a%2Fb')
})

test('AutoDL response parsing stays stateless across interleaved vendor tasks', () => {
  assert.deepEqual(video.parseGenerateResponse({ id: 'seedance-task' }), { isAsync: true, taskId: 'seedance-task' })
  assert.deepEqual(video.parseGenerateResponse({ output: { task_id: 'wan-task' } }), { isAsync: true, taskId: 'wan-task' })
  assert.deepEqual(video.parseGenerateResponse({ task_id: 'h3-task' }), { isAsync: true, taskId: 'h3-task' })
  assert.deepEqual(video.parsePollResponse({ output: { task_status: 'RUNNING' } }), { status: 'processing' })
  assert.deepEqual(video.parsePollResponse({ task: { status: 'failed', error: { code: 'InvalidInput', message: 'bad input' } } }), { status: 'failed', error: '[InvalidInput] bad input' })
  assert.deepEqual(video.parsePollResponse({ status: 'succeeded', request_id: 'seedance-request', content: { video_url: 'https://example.com/seedance.mp4' } }), { status: 'completed', videoUrl: 'https://example.com/seedance.mp4' })
  assert.deepEqual(video.parsePollResponse({ output: { task_status: 'SUCCEEDED', video_url: 'https://example.com/wan.mp4' }, usage: { output_video_duration: 6 } }), { status: 'completed', videoUrl: 'https://example.com/wan.mp4', duration: 6 })
  assert.deepEqual(video.parsePollResponse({ task: { status: 'succeeded', content: { url: 'https://example.com/h3.mp4' } } }), { status: 'completed', videoUrl: 'https://example.com/h3.mp4' })
  assert.equal(video.parsePollResponse({ status: 'cancelled' }).status, 'failed')
  assert.equal(video.parsePollResponse({ output: { task_status: 'CANCELED' } }).status, 'failed')
  assert.equal(video.extractVideoUrl({ task: { content: { url: 'https://example.com/h3.mp4' } } }), 'https://example.com/h3.mp4')
})

test('AutoDL configs create, read, update, select, and probe through the real routes', async () => {
  for (const [serviceType, model] of Object.entries(models)) {
    const response = await app.request('/ai-configs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
      service_type: serviceType, provider: 'AutoDL', base_url: origin, api_key: 'test-token', model: [model], priority: 10,
    }) })
    assert.equal(response.status, 201)
    const saved = (await response.json() as any).data
    configIds.set(serviceType, saved.id)
    assert.equal(saved.provider, 'autodl')
    assert.equal((await getConfigById(saved.id))?.model, model)
    assert.equal((await getActiveConfig(serviceType as 'text' | 'image' | 'video'))?.provider, 'autodl')
    const update = await app.request(`/ai-configs/${saved.id}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ provider: 'AutoDL', priority: 20 }) })
    assert.equal(update.status, 200)
    const read = await app.request(`/ai-configs/${saved.id}`)
    assert.deepEqual((await read.json() as any).data.model, [model])
  }
  const probe = await app.request('/ai-configs/test', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
    service_type: 'text', provider: 'autodl', base_url: origin + '/api/v1/', api_key: 'test-token', model: [models.text],
  }) })
  assert.equal(probe.status, 200)
  assert.equal((await probe.json() as any).data.ok, true)
  const request = requests.find(request => request.url === '/api/v1/models')!
  assert.equal(request.method, 'GET')
  assert.equal(request.authorization, 'Bearer test-token')
})

async function waitForTask(task: number, timeout = 20_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const record = sqlite.prepare('SELECT * FROM sys_task WHERE id = ?').get(task) as any
    if (record.status === 'completed' || record.status === 'failed') {
      if (getRun(taskRunId(task)!)?.status !== 'running') return record
    }
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error(`AutoDL task ${task} did not finish within ${timeout}ms`)
}

test('the AutoDL text agent calls chat/completions and saves its script through a real tool', async () => {
  sqlite.prepare("INSERT INTO dramas(id,title,created_at,updated_at) VALUES(1,'isolated test','now','now')").run()
  sqlite.prepare("INSERT INTO episodes(id,drama_id,episode_number,title,content,created_at,updated_at) VALUES(1,1,1,'test','小林走进书房。','now','now')").run()
  await executeAgent('script_rewriter', [{ role: 'user', content: '改写并保存' }], {
    requestContext: buildAgentRequestContext({ episodeId: 1, dramaId: 1, textConfigId: configIds.get('text'), language: 'zh' }),
    maxSteps: 3,
  })
  const episode = sqlite.prepare('SELECT script_content FROM episodes WHERE id = 1').get() as any
  assert.match(episode.script_content, /AutoDL 文本接入成功/)
  const request = requests.find(request => request.url === '/api/v1/chat/completions')!
  assert.equal(request.body.model, models.text)
  assert.equal(request.authorization, 'Bearer test-token')
})

test('AutoDL image generation saves the returned base64 image to isolated storage', async () => {
  const id = await generateImage({ prompt: '一只猫', configId: configIds.get('image') })
  const record = await waitForTask(id)
  assert.equal(record.status, 'completed', record.error_msg)
  assert.deepEqual(await readFile(path.join(directory, record.local_path)), imageBytes)
  const request = requests.find(request => request.url === '/api/v1/images/generations')!
  assert.equal(request.authorization, 'test-token')
  assert.equal(request.body.size, '1664x928')
})

test('Wan tasks under an AutoDL config use Wan validation and poll the overridden model route', async () => {
  const references = Array.from({ length: 10 }, (_, index) => `https://example.com/ref-${index}.png`)
  const response = await app.request('/tasks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
    type: 'video', config_id: configIds.get('video'), model: 'wan3.0-video', prompt: '走进房间', reference_image_urls: references,
  }) })
  assert.equal(response.status, 201, await response.clone().text())
  const record = await waitForTask((await response.json() as any).data.id)
  assert.equal(record.status, 'failed')
  assert.match(record.error_msg, /verified Wan polling route/)
  const submit = requests.find(request => request.url === '/api/v1/ali/api/v1/services/aigc/video-generation/video-synthesis')!
  assert.equal(submit.body.input.media.length, 10)
  assert.equal(submit.body.model, 'wan3.0-video')
  assert.ok(requests.some(request => request.url === '/api/v1/ali/api/v1/tasks/wan-task'))
  assert.equal(requests.some(request => request.url === '/api/v1/ark/v3/contents/generations/tasks/wan-task'), false)
})
