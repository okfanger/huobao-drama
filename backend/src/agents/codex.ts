import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Codex } from '@openai/codex-sdk'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import type { RequestContext } from '@mastra/core/request-context'
import { AGENT_TOOLS } from './index.js'
import { appendEvent, inRun, outputBuffer } from '../services/ai-runs.js'
import { findCodex, codexStatus } from '../services/codex-status.js'
import { sqlite } from '../db/index.js'

// IDs supplied by the model must belong to this run's project/episode.
function checkScope(input: any, requestContext: RequestContext<any>): void {
  const dramaId = requestContext.get('dramaId'), episodeId = requestContext.get('episodeId')
  for (const [key, value] of Object.entries(input || {})) {
    const table = ({ character_id: 'characters', scene_id: 'scenes', prop_id: 'props', storyboard_id: 'storyboards', character_ids: 'characters', prop_ids: 'props' } as Record<string, string>)[key]
    if (table && value != null) {
      for (const id of Array.isArray(value) ? value : [value]) {
        const row = sqlite.prepare(`SELECT ${table === 'storyboards' ? 'episode_id' : 'drama_id'} AS owner FROM ${table} WHERE id=?`).get(id) as any
        if (!row || row.owner !== (table === 'storyboards' ? episodeId : dramaId)) throw new Error(`${key} is outside this run's context`)
      }
    } else if (Array.isArray(value)) value.forEach(item => { if (item && typeof item === 'object') checkScope(item, requestContext) })
  }
}

export async function startToolBridge(type: string, requestContext: RequestContext<any>, runId: string, maxCalls: number, signal: AbortSignal, onLimit?: () => void) {
  const token = randomBytes(32).toString('hex')
  const tools = new Map(Object.values(AGENT_TOOLS[type]).map(tool => [tool.id, tool]))
  const calls = new Map<string, { args: string; promise: Promise<any> }>()
  let count = 0
  const active = new Set<Server>()
  const http = createServer(async (req, res) => {
    if (req.url !== '/mcp' || req.headers.authorization !== `Bearer ${token}` || signal.aborted) {
      res.writeHead(403); res.end(); return
    }
    const server = new Server({ name: 'huobao-tools', version: '1.0.0' }, { capabilities: { tools: {} } })
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    active.add(server)
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [...tools].map(([name, tool]) => ({ name, description: tool.description, inputSchema: tool.inputSchema ? z.toJSONSchema(tool.inputSchema, { unrepresentable: 'any' }) as any : { type: 'object', properties: {} } })) }))
    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const cacheKey = String(extra.requestId)
      const argsKey = JSON.stringify(request.params)
      const previous = calls.get(cacheKey)
      if (previous) {
        if (previous.args !== argsKey) throw new Error('Reused tool request id with different arguments')
        return previous.promise
      }
      const promise = inRun(runId, async () => {
        const tool = tools.get(request.params.name)
        if (!tool) throw new Error('Tool not available for this agent')
        if (signal.aborted) throw new Error('Run stopped')
        if (++count > maxCalls) { appendEvent(runId, 'error', { message: `Tool call limit exceeded (${maxCalls})` }); onLimit?.(); throw new Error(`Tool call limit exceeded (${maxCalls})`) }
        const started = Date.now()
        appendEvent(runId, 'tool-start', { tool_call_id: cacheKey, tool_name: tool.id, args: request.params.arguments })
        try {
          const input = tool.inputSchema ? await tool.inputSchema.parseAsync(request.params.arguments || {}) : request.params.arguments || {}
          checkScope(input, requestContext)
          const result = await tool.execute(input, { requestContext })
          const isError = Boolean(result?.error)
          appendEvent(runId, 'tool-end', { tool_call_id: cacheKey, tool_name: tool.id, result, is_error: isError, elapsed_ms: Date.now() - started })
          return { content: [{ type: 'text' as const, text: JSON.stringify(result ?? null) }], isError }
        } catch (error) {
          appendEvent(runId, 'tool-end', { tool_call_id: cacheKey, tool_name: tool.id, error, is_error: true, elapsed_ms: Date.now() - started })
          return { content: [{ type: 'text' as const, text: (error as Error).message }], isError: true }
        }
      })
      calls.set(cacheKey, { args: argsKey, promise })
      return promise
    })
    res.on('close', () => { active.delete(server); void server.close() })
    try { await server.connect(transport); await transport.handleRequest(req, res) }
    catch { if (!res.headersSent) res.writeHead(500); res.end() }
  })
  await new Promise<void>((resolve, reject) => { http.once('error', reject); http.listen(0, '127.0.0.1', resolve) })
  const address = http.address() as { port: number }
  return { url: `http://127.0.0.1:${address.port}/mcp`, token,
    async close() { await Promise.all([...active].map(server => server.close())); http.closeAllConnections(); await new Promise<void>(resolve => http.close(() => resolve())) } }
}

export async function runCodex(type: string, instructions: string, messages: any[], opts: { requestContext: RequestContext<any>; maxSteps: number; model?: string; runId: string; signal: AbortSignal }) {
  const status = await codexStatus()
  if (!status.installed || !status.logged_in) throw new Error(status.message || 'Sign in to Codex with ChatGPT.')
  const executable = await findCodex()
  const directory = await mkdtemp(path.join(tmpdir(), 'huobao-codex-'))
  const controller = new AbortController()
  const signal = AbortSignal.any([opts.signal, controller.signal])
  let bridge: Awaited<ReturnType<typeof startToolBridge>> | undefined
  const output = outputBuffer(opts.runId)
  const toolCalls: any[] = [], toolResults: any[] = []
  let text = ''
  let usage: unknown = null
  let completed = false
  let toolFailure: string | undefined
  const snapshots = new Map<string, string>()
  try {
    bridge = await startToolBridge(type, opts.requestContext, opts.runId, opts.maxSteps, signal, () => controller.abort(new Error(`Tool call limit exceeded (${opts.maxSteps})`)))
    const env: Record<string, string> = {}
    for (const key of ['PATH', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'SYSTEMROOT', 'TEMP', 'TMP', 'CODEX_HOME', 'HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'NO_PROXY']) {
      if (process.env[key]) env[key] = process.env[key]!
    }
    const codex = new Codex({ codexPathOverride: executable, env,
      config: { features: { shell_tool: false, apps: false, plugins: false }, model_reasoning_effort: 'low' },
      configOverrides: [`mcp_servers={huobao={url=${JSON.stringify(bridge.url)},required=true,default_tools_approval_mode="approve",http_headers={Authorization=${JSON.stringify(`Bearer ${bridge.token}`)}}}}`, 'plugins={}'],
    })
    const thread = codex.startThread({ model: opts.model && opts.model !== 'default' ? opts.model : undefined, workingDirectory: directory, skipGitRepoCheck: true,
      sandboxMode: 'read-only', approvalPolicy: 'never', webSearchMode: 'disabled', networkAccessEnabled: false })
    const prompt = `${instructions}\n\nUse only the huobao MCP tools to read and save application data. Complete the requested saves before finishing.\n\n${messages.map(message => `${message.role}: ${typeof message.content === 'string' ? message.content : JSON.stringify(message.content)}`).join('\n\n')}`
    appendEvent(opts.runId, 'model-request', { transport: 'codex-sdk', model: opts.model || 'default', instructions, messages, prompt, internal_requests: 'not_provided' })
    const stream = await thread.runStreamed(prompt, { signal })
    for await (const event of stream.events) {
      if (event.type === 'thread.started') appendEvent(opts.runId, 'sdk-thread', { thread_id: event.thread_id })
      else if (event.type === 'turn.failed' || event.type === 'error') throw new Error(event.type === 'turn.failed' ? event.error.message : event.message)
      else if (event.type === 'turn.completed') { completed = true; usage = event.usage }
      else if ('item' in event) {
        const item = event.item
        if (item.type === 'agent_message') {
          const prev = snapshots.get(item.id) || ''
          if (item.text.startsWith(prev)) output.push(item.id, item.text.slice(prev.length))
          else { output.flush(); appendEvent(opts.runId, 'model-output', { item_id: item.id, text: item.text, replace: true }) }
          snapshots.set(item.id, item.text)
          text = item.text
        } else if (item.type === 'mcp_tool_call' && event.type === 'item.completed') {
          toolCalls.push({ toolName: item.tool, args: item.arguments })
          toolResults.push({ toolName: item.tool, result: item.result, isError: item.status === 'failed' })
          if (item.status === 'failed') {
            toolFailure = item.error?.message || `Codex tool failed: ${item.tool}`
            appendEvent(opts.runId, 'error', { tool_name: item.tool, error: item.error })
          }
        } else if (item.type !== 'reasoning' && event.type === 'item.completed') appendEvent(opts.runId, 'sdk-item', item)
      }
    }
    if (!completed) throw new Error('Codex ended without completing the turn')
    output.flush()
    appendEvent(opts.runId, 'usage', usage)
    if (toolFailure) throw new Error(toolFailure)
    return { text, toolCalls, toolResults, usage }
  } catch (error) {
    if (signal.aborted) throw signal.reason
    throw error
  } finally { output.flush(); await bridge?.close(); await rm(directory, { recursive: true, force: true }) }
}
