import { test } from 'node:test'
import assert from 'node:assert/strict'
import { groupRunEvents } from '../app/utils/interaction-timeline.mjs'

const event = (id, run_id, type, data = {}) => ({ id, run_id, type, data, created_at: new Date(id * 1000).toISOString() })
test('poll cycles merge by run while preserving every request and response across parallel runs', () => {
  const records = [event(1, 'one', 'provider-wait'), event(2, 'two', 'provider-wait'), event(3, 'one', 'model-request'),
    event(4, 'one', 'model-response', { body: { status: 'running' } }), event(5, 'one', 'provider-wait'),
    event(6, 'two', 'model-request'), event(7, 'one', 'model-response'), event(8, 'one', 'download-start')]
  const steps = groupRunEvents(records)
  assert.equal(steps.length, 3)
  assert.deepEqual(steps[0].raw.map(e => e.id), [1, 3, 4, 5, 7])
  assert.deepEqual(steps[1].raw.map(e => e.id), [2, 6])
  assert.equal(steps[0].count, 2)
  assert.equal(steps[2].type, 'download-start')
  assert.equal(records[0].data.is_error, undefined)
})
test('duplicate events are ignored, output deltas remain complete and separate tools/runs stay separate', () => {
  const first = event(1, 'one', 'model-output', { item_id: 'text', text: 'a', delta: true })
  const records = [first, first, event(2, 'one', 'model-output', { item_id: 'text', text: 'b', delta: true }),
    event(3, 'two', 'model-output', { item_id: 'text', text: 'other', delta: true }), event(4, 'one', 'tool-start'),
    event(5, 'one', 'model-output', { item_id: 'text', text: 'c', delta: true })]
  const steps = groupRunEvents(records)
  assert.equal(steps[0].data.text, 'ab'); assert.equal(steps[0].raw.length, 2)
  assert.equal(steps[1].data.text, 'other'); assert.equal(steps[2].type, 'tool-start'); assert.equal(steps[3].data.text, 'c')
  assert.equal(first.data.text, 'a')
})
