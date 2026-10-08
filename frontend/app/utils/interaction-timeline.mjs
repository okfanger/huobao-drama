/** Presentation only: never discard original event details when grouping. */
export function groupRunEvents(events) {
  const steps = [], waits = new Map(), seen = new Set()
  for (const event of [...events].sort((a, b) => a.id - b.id)) {
    if (seen.has(event.id)) continue
    seen.add(event.id)
    const waiting = waits.get(event.run_id)
    if (waiting && ['provider-wait', 'model-request', 'model-response', 'poll-error'].includes(event.type)) {
      waiting.raw.push(event)
      waiting.last_at = event.created_at
      if (event.type === 'provider-wait') waiting.count++
      if (event.type === 'poll-error') waiting.data.is_error = true
      continue
    }
    waits.delete(event.run_id)
    const previous = steps.at(-1)
    if (event.type === 'model-output' && event.data?.delta && previous?.type === event.type && previous.run_id === event.run_id && previous.data.item_id === event.data.item_id) {
      previous.data.text += event.data.text || ''
      previous.count++; previous.raw.push(event); previous.last_at = event.created_at
      continue
    }
    const step = { ...event, data: { ...event.data }, count: 1, raw: [event], last_at: event.created_at }
    steps.push(step)
    if (event.type === 'provider-wait') waits.set(event.run_id, step)
  }
  return steps
}
