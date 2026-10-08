import type { RequestContext } from '@mastra/core/request-context'
import { agentRegistry, buildInstructions, resolveAgentConfig } from './index.js'
import { createRun, finishRun, inRun, appendEvent, outputBuffer, updateRun } from '../services/ai-runs.js'
import { runCodex } from './codex.js'

export interface AgentExecutionOptions {
  requestContext: RequestContext<any>; maxSteps: number; onStepFinish?: (step: any) => any
  runId?: string; source?: string; targetId?: number
}
export async function executeAgent(type: string, messages: any[], opts: AgentExecutionOptions): Promise<any> {
  const runId = opts.runId || createRun({ service_type: 'text', source: opts.source || type,
    drama_id: opts.requestContext.get('dramaId' as never) as number,
    episode_id: opts.requestContext.get('episodeId' as never) as number, target_id: opts.targetId })
  return inRun(runId, async () => {
    const buffer = outputBuffer(runId)
    const signal = AbortSignal.timeout(600000)
    try {
      const { config, model } = await resolveAgentConfig(type, opts.requestContext)
      updateRun(runId, { provider: config.provider, model: model || 'default' })
      const instructions = await buildInstructions(type)({ requestContext: opts.requestContext })
      appendEvent(runId, 'instructions', { instructions, messages })
      let result: any
      if (config.provider === 'codex') {
        result = await runCodex(type, instructions, messages, { requestContext: opts.requestContext, maxSteps: opts.maxSteps, model, runId, signal })
      } else {
        const agent = agentRegistry[type]
        if (!agent) throw new Error('Agent not found')
        const stream = await agent.stream(messages, { requestContext: opts.requestContext, maxSteps: opts.maxSteps, onStepFinish: opts.onStepFinish, abortSignal: signal })
        for await (const chunk of stream.fullStream) {
          const entry = chunk as any
          const payload = entry.payload
          if (entry.type === 'text-delta') buffer.push(payload.id || 'text', payload.text || '')
          else if (entry.type === 'tool-call') { buffer.flush(); appendEvent(runId, 'tool-start', payload) }
          else if (entry.type === 'tool-result') appendEvent(runId, 'tool-end', payload)
          else if (entry.type === 'error') throw new Error(payload?.error?.message || payload?.message || String(payload?.error || 'Model stream failed'))
        }
        buffer.flush()
        if (stream.error) throw stream.error instanceof Error ? stream.error : new Error(String(stream.error))
        result = await stream.getFullOutput()
        appendEvent(runId, 'usage', result.usage || null)
      }
      appendEvent(runId, 'result', { text: result.text, tool_calls: result.toolCalls?.length || 0 })
      finishRun(runId)
      return { ...result, run_id: runId }
    } catch (error) { buffer.flush(); finishRun(runId, error); throw error }
  })
}
