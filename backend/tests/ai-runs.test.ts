import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { once } from 'node:events'
import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const directory = await mkdtemp(path.join(tmpdir(), 'huobao-runs-test-'))
process.env.SQLITE_PATH = path.join(directory, 'db.sqlite3')
process.env.HUOBAO_DATA_DIR = directory
process.env.WORKSPACE_PATH = path.join(directory, 'workspace')
const { sqlite } = await import('../src/db/index.js')
const runs = await import('../src/services/ai-runs.js')
const { interactionData } = await import('../src/services/interaction-data.js')
const { tracedFetch } = await import('../src/services/traced-fetch.js')
const { default: routes } = await import('../src/routes/aiRuns.js')
const { startToolBridge, runCodex } = await import('../src/agents/codex.js')
const { buildAgentRequestContext } = await import('../src/agents/context.js')
const makeRun = (episode = 100) => runs.createRun({ service_type: 'text', source: 'test', episode_id: episode, drama_id: 1 })
after(async () => { sqlite.close(); await rm(directory, { recursive: true, force: true }) })

test('serialization preserves long text and numeric usage, redacts credentials and replaces binary', () => {
  const prose = '长文本 🌟 '.repeat(20000)
  const data = interactionData({ prose, usage: { input_tokens: 1234, output_tokens: 42 }, Authorization: 'Bearer secret',
    headers: new Headers({ 'x-goog-api-key': 'secret', 'x-api-key': 'secret' }), apiKey: 'secret',
    url: 'https://user:secret@example.test/media?key=secret&X-Amz-Signature=secret',
    b64_json: 'AAAA', image: 'data:image/png;base64,AAAA', inlineData: { mimeType: 'image/png', data: 'AAAA' },
    bytes: Buffer.from('private binary') })
  assert.equal(data.prose, prose)
  assert.equal(data.usage.input_tokens, 1234)
  assert.equal(data.b64_json.omitted, 'binary')
  assert.equal(data.inlineData.data.omitted, 'binary')
  assert.equal(data.image.mime_type, 'image/png')
  assert.doesNotMatch(JSON.stringify(data), /secret|AAAA|private binary/)
  assert.doesNotMatch(String(interactionData(JSON.stringify({ api_key: 'secret', b64_json: 'AAAA' }))), /secret|AAAA/)
  assert.doesNotMatch(String(interactionData('reference: data:image/png;base64,AAAA')), /AAAA/)
})

test('parallel contexts, deferred parent completion and coalesced deltas never mix runs', async () => {
  const parent = makeRun(), other = makeRun()
  let child = ''
  await Promise.all([
    runs.inRun(parent, async () => { await Promise.resolve(); child = makeRun(); runs.traceEvent('tool-start', { owner: 'parent' }) }),
    runs.inRun(other, async () => { await Promise.resolve(); runs.traceEvent('tool-start', { owner: 'other' }) }),
  ])
  assert.equal(runs.getRun(child)?.parent_id, parent)
  assert.equal(runs.eventsForRun(other).filter(e => e.type === 'tool-start')[0].data.owner, 'other')
  const buffer = runs.outputBuffer(child)
  buffer.push('one', 'a'); buffer.push('one', 'b')
  await new Promise(resolve => setTimeout(resolve, 125))
  buffer.push('one', 'c'); buffer.flush()
  assert.equal(runs.eventsForRun(child).filter(e => e.type === 'model-output').map(e => e.data.text).join(''), 'abc')
  runs.finishRun(parent)
  assert.equal(runs.getRun(parent)?.status, 'running')
  runs.finishRun(child); runs.finishRun(other)
  assert.equal(runs.getRun(parent)?.status, 'completed')
  assert.equal(runs.appendEvent(parent, 'late', {}), 0)
})

test('HTTP capture retains actual final requests and provider SSE responses without binary', async () => {
  const id = makeRun()
  const original = globalThis.fetch
  const payload = '完整响应'.repeat(10000)
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({ text: payload, b64_json: 'AAAA' }), { headers: { 'content-type': 'application/json' } })
    await runs.inRun(id, () => tracedFetch('https://provider.test/model?key=secret', { method: 'POST', headers: { Authorization: 'Bearer secret' }, body: JSON.stringify({ messages: [{ content: payload }], temperature: 0 }) }))
    globalThis.fetch = async () => new Response(`data: ${JSON.stringify({ delta: '🌟', usage: { input_tokens: 5 } })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } })
    const response = await runs.inRun(id, () => tracedFetch('https://provider.test/model'))
    await response.text()
    const records = runs.eventsForRun(id)
    assert.equal(records.find(e => e.type === 'model-request')?.data.body.temperature, 0)
    assert.equal(records.find(e => e.type === 'model-response')?.data.body.text, payload)
    assert.equal(records.filter(e => e.type === 'model-response')[1].data.chunks[0].delta, '🌟')
    assert.doesNotMatch(JSON.stringify(records), /secret|AAAA/)
  } finally { globalThis.fetch = original; runs.finishRun(id) }
})

test('list pagination handles identical timestamps and excludes event bodies', async () => {
  const ids = Array.from({ length: 5 }, () => makeRun(101))
  ids.forEach(id => { sqlite.prepare('UPDATE ai_runs SET started_at=? WHERE id=?').run('2026-01-01T00:00:00.000Z', id); runs.appendEvent(id, 'result', { text: 'secret prose' }); runs.finishRun(id) })
  const app = new Hono().route('/ai-runs', routes)
  let cursor = '', all: string[] = []
  do {
    const response = await app.request(`/ai-runs?episode_id=101&limit=2${cursor ? `&cursor=${cursor}` : ''}`)
    const data = (await response.json() as any).data
    assert.doesNotMatch(JSON.stringify(data), /secret prose/)
    all.push(...data.items.map((r: any) => r.id)); cursor = data.next_cursor || ''
  } while (cursor)
  assert.deepEqual(new Set(all), new Set(ids))
  assert.equal(all.length, 5)
})

test('SSE reconnect replays only missed episode events and closing the viewer does not finish the run', async () => {
  const app = new Hono().route('/ai-runs', routes)
  const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' })
  if (!server.listening) await once(server, 'listening')
  const address = server.address() as { port: number }
  const id = makeRun(102), foreign = makeRun(103)
  const first = runs.appendEvent(id, 'result', { text: 'first' })
  async function readAfter(after: number, useHeader = false) {
    const controller = new AbortController()
    const response = await fetch(`http://127.0.0.1:${address.port}/ai-runs/stream?episode_id=102${useHeader ? '' : `&after_id=${after}`}`, { headers: useHeader ? { 'Last-Event-ID': String(after) } : {}, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]) })
    const reader = response.body!.getReader()
    const decoder = new TextDecoder(); let text = ''
    try { while (!text.includes('event: interaction') || !text.slice(text.indexOf('event: interaction')).includes('\n\n')) text += decoder.decode((await reader.read()).value, { stream: true }) }
    finally { controller.abort(); await reader.cancel().catch(() => {}) }
    return text.split('\n\n').filter(part => part.includes('event: interaction')).map(part => JSON.parse(part.split('\n').find(line => line.startsWith('data:'))!.slice(5)))
  }
  try {
    const initial = await readAfter(first - 1)
    assert.equal(initial[0].id, first)
    assert.equal(runs.getRun(id)?.status, 'running')
    runs.appendEvent(foreign, 'result', { text: 'foreign' })
    const second = runs.appendEvent(id, 'result', { text: 'second' })
    const replay = await readAfter(first, true)
    assert.deepEqual(replay.map(e => e.id), [second])
    assert.equal(replay[0].data.text, 'second')
    runs.finishRun(id); runs.finishRun(foreign)
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
})

test('MCP bridge binds context, rejects unauthorized access/invalid args and deduplicates a write request', async () => {
  sqlite.prepare("INSERT INTO dramas(id,title,created_at,updated_at) VALUES(1,'test','now','now')").run()
  sqlite.prepare("INSERT INTO episodes(id,drama_id,episode_number,title,content,created_at,updated_at) VALUES(1,1,1,'test','original','now','now')").run()
  const id = makeRun(1), rc = buildAgentRequestContext({ episodeId: 1, dramaId: 1 })
  const bridge = await startToolBridge('script_rewriter', rc, id, 4, AbortSignal.timeout(10000))
  const client = new Client({ name: 'test', version: '1' })
  try {
    assert.equal((await fetch(bridge.url)).status, 403)
    await client.connect(new StreamableHTTPClientTransport(new URL(bridge.url), { requestInit: { headers: { Authorization: `Bearer ${bridge.token}` } } }))
    const names = (await client.listTools()).tools.map(t => t.name)
    assert.ok(names.includes('save_script')); assert.ok(!names.includes('save_storyboards'))
    const result = await client.callTool({ name: 'read_episode_script', arguments: {} })
    assert.match(JSON.stringify(result), /original/)
    const invalid = await client.callTool({ name: 'save_script', arguments: { content: 5 } })
    assert.equal(invalid.isError, true)
    const request = { jsonrpc: '2.0', id: 'duplicate-write', method: 'tools/call', params: { name: 'save_script', arguments: { content: 'saved once' } } }
    async function send() { return fetch(bridge.url, { method: 'POST', headers: { Authorization: `Bearer ${bridge.token}`, 'content-type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify(request) }) }
    assert.equal((await send()).status, 200); assert.equal((await send()).status, 200)
    assert.equal((sqlite.prepare('SELECT script_content FROM episodes WHERE id=1').get() as any).script_content, 'saved once')
    assert.equal(runs.eventsForRun(id).filter(e => e.type === 'tool-start' && e.data.tool_name === 'save_script').length, 2) // invalid call + one write
    await client.callTool({ name: 'read_episode_script', arguments: {} })
    await assert.rejects(client.callTool({ name: 'read_episode_script', arguments: {} }), /limit exceeded/)
    assert.equal(runs.eventsForRun(id).filter(e => e.type === 'tool-start').length, 4)
  } finally { await client.close(); await bridge.close(); runs.finishRun(id) }
})

test('MCP rejects assets outside the run project before executing writes', async () => {
  sqlite.prepare("INSERT INTO characters(id,drama_id,name,created_at,updated_at) VALUES(9,9,'foreign','now','now')").run()
  const id = makeRun(1), rc = buildAgentRequestContext({ episodeId: 1, dramaId: 1 })
  const bridge = await startToolBridge('prompt_generator', rc, id, 4, AbortSignal.timeout(10000))
  const client = new Client({ name: 'test', version: '1' })
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(bridge.url), { requestInit: { headers: { Authorization: `Bearer ${bridge.token}` } } }))
    const response = await client.callTool({ name: 'save_character_final_prompt', arguments: { character_id: 9, prompt: 'should never save' } })
    assert.equal(response.isError, true)
    assert.equal((sqlite.prepare('SELECT final_prompt FROM characters WHERE id=9').get() as any).final_prompt, null)
    assert.ok(runs.eventsForRun(id).some(e => e.type === 'tool-end' && e.data.is_error))
  } finally { await client.close(); await bridge.close(); runs.finishRun(id) }
})

test('official SDK consumes CLI JSONL snapshots without duplicate output; errors and timeouts propagate', { skip: process.platform === 'win32' }, async () => {
  const fake = path.join(directory, 'codex')
  await writeFile(fake, `#!/usr/bin/env node
const args = process.argv.slice(2)
if(args.includes('--version')) { console.log('codex-cli mock'); process.exit(0) }
if(args[0]==='login') { console.log('Logged in using ChatGPT'); process.exit(0) }
if(args.includes('timeout')) { setInterval(()=>{},1000) }
else if(args.includes('failure')) { console.log(JSON.stringify({type:'turn.failed',error:{message:'model unavailable'}})) }
else if(args.includes('tool-failure')) { console.log(JSON.stringify({type:'item.completed',item:{id:'tool',type:'mcp_tool_call',server:'huobao',tool:'save_script',arguments:{},status:'failed',error:{message:'approval denied'}}})); console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:4,output_tokens:1}})) }
else {
 for(const event of [{type:'thread.started',thread_id:'test'}, {type:'item.updated',item:{type:'agent_message',id:'one',text:'hello'}}, {type:'item.updated',item:{type:'agent_message',id:'one',text:'hello'}}, {type:'item.completed',item:{type:'agent_message',id:'one',text:'hello world'}}, {type:'turn.completed',usage:{input_tokens:42,output_tokens:5,cached_input_tokens:0}}]) console.log(JSON.stringify(event))
}
`)
  await chmod(fake, 0o755)
  const original = process.env.HUOBAO_CODEX_BIN; process.env.HUOBAO_CODEX_BIN = fake
  const rc = buildAgentRequestContext({ episodeId: 1, dramaId: 1 })
  try {
    const id = makeRun(1)
    const result = await runCodex('script_rewriter', 'instructions', [{ role: 'user', content: 'test' }], { requestContext: rc, maxSteps: 4, runId: id, signal: AbortSignal.timeout(5000) })
    assert.equal(result.text, 'hello world')
    assert.equal(runs.eventsForRun(id).filter(e => e.type === 'model-output').map(e => e.data.text).join(''), 'hello world')
    assert.equal(runs.eventsForRun(id).find(e => e.type === 'usage')?.data.input_tokens, 42)
    runs.finishRun(id)
    for (const model of ['failure', 'tool-failure', 'timeout']) {
      const failed = makeRun(1)
      await assert.rejects(runCodex('script_rewriter', '', [], { requestContext: rc, maxSteps: 4, model, runId: failed, signal: AbortSignal.timeout(model === 'timeout' ? 250 : 5000) }))
      runs.finishRun(failed, 'failed')
      assert.equal(runs.getRun(failed)?.status, 'failed')
    }
  } finally { if (original === undefined) delete process.env.HUOBAO_CODEX_BIN; else process.env.HUOBAO_CODEX_BIN = original }
})

test('restart marks unfinished runs interrupted; 30-day cleanup removes only closed records, never media', async () => {
  const active = makeRun(104), expired = makeRun(104)
  runs.finishRun(expired)
  sqlite.prepare('UPDATE ai_runs SET finished_at=? WHERE id=?').run('2020-01-01', expired)
  const asset = path.join(directory, 'generated.png'); await writeFile(asset, 'media')
  assert.equal(runs.clearRuns('2021-01-01'), 1)
  assert.ok(runs.getRun(active)); assert.equal(runs.getRun(expired), undefined)
  runs.startRunMaintenance()
  assert.equal(runs.getRun(active)?.status, 'interrupted')
  const { readFile } = await import('node:fs/promises')
  assert.equal(await readFile(asset, 'utf8'), 'media')
})
