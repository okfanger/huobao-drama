import { randomUUID } from 'node:crypto'
import { appendEvent, currentRunId } from './ai-runs.js'

/** Innermost fetch: records the final request after provider compatibility patches. */
export const tracedFetch: typeof fetch = async (input, init) => {
  const runId = currentRunId()
  if (!runId) return fetch(input, init)
  const requestId = randomUUID()
  const url = typeof input === 'string' || input instanceof URL ? String(input) : input.url
  let body: unknown = init?.body
  if (body === undefined && input instanceof Request) body = await input.clone().text()
  if (typeof body === 'string') { try { body = JSON.parse(body) } catch {} }
  appendEvent(runId, 'model-request', { request_id: requestId, url, method: init?.method || (input instanceof Request ? input.method : 'GET'), headers: new Headers(init?.headers || (input instanceof Request ? input.headers : undefined)), body })
  const started = Date.now()
  try {
    const response = await fetch(input, init)
    if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream')) {
      const contentType = response.headers.get('content-type') || ''
      let data: unknown
      if (/^(image\/|video\/|audio\/|application\/octet-stream)/i.test(contentType)) data = await response.clone().blob()
      else {
        const raw = await response.clone().text()
        data = raw
        try { data = JSON.parse(raw) } catch {}
      }
      appendEvent(runId, 'model-response', { request_id: requestId, status: response.status, elapsed_ms: Date.now() - started, body: data })
      return response
    }
    const decoder = new TextDecoder()
    let remainder = ''
    const chunks: unknown[] = []
    const accept = (line: string) => {
      if (!line.startsWith('data:')) return
      const data = line.slice(5).trim()
      if (!data || data === '[DONE]') return
      try { chunks.push(JSON.parse(data)) } catch { chunks.push(data) }
    }
    const tapped = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        remainder += decoder.decode(chunk, { stream: true })
        const lines = remainder.split('\n')
        remainder = lines.pop() || ''
        lines.forEach(accept)
        controller.enqueue(chunk)
      },
      flush() {
        remainder += decoder.decode()
        accept(remainder)
        appendEvent(runId, 'model-response', { request_id: requestId, status: response.status, elapsed_ms: Date.now() - started, chunks })
      },
    }))
    return new Response(tapped, { status: response.status, statusText: response.statusText, headers: response.headers })
  } catch (error) {
    appendEvent(runId, 'error', { request_id: requestId, error })
    throw error
  }
}
