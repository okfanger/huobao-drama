<template>
  <section class="interaction-center">
    <div class="interaction-filters">
      <select v-model="kind" class="input" :aria-label="t('interactions.type')">
        <option value="">{{ t('interactions.allTypes') }}</option>
        <option v-for="k in ['text','image','video']" :key="k" :value="k">{{ t('common.serviceType.' + k) }}</option>
      </select>
      <select v-model="status" class="input" :aria-label="t('interactions.status')">
        <option value="">{{ t('interactions.allStatuses') }}</option>
        <option v-for="s in statuses" :key="s" :value="s">{{ t('interactions.' + s) }}</option>
      </select>
      <button class="btn btn-sm" @click="reload(); loadDetail()">{{ t('common.refresh') }}</button>
      <button class="btn btn-ghost btn-sm" @click="confirmClear = !confirmClear">{{ t('interactions.clear') }}</button>
    </div>
    <div v-if="confirmClear" class="interaction-notice">
      {{ t('interactions.clearHint') }}
      <button class="btn btn-sm" @click="clearHistory">{{ t('common.confirm') }}</button>
      <button class="btn btn-ghost btn-sm" @click="confirmClear = false">{{ t('common.cancel') }}</button>
    </div>
    <div class="interaction-notice" aria-live="polite">{{ error || t(connected ? 'interactions.live' : 'interactions.reconnecting') }}</div>
    <div v-if="!selected" class="interaction-list">
      <p v-if="!runs.length && !loading" class="interaction-notice">{{ t('interactions.empty') }}</p>
      <article v-for="run in runs" :key="run.id" class="interaction-run">
        <div><strong>{{ sourceLabel(run.source) }}</strong><span class="interaction-tag">{{ t('common.serviceType.' + run.service_type) }}</span></div>
        <div class="interaction-meta">{{ time(run.started_at) }} · {{ duration(run) }} · {{ providerLabel(run) }}</div>
        <div class="interaction-row"><span :class="'interaction-status is-' + run.status">{{ t('interactions.' + run.status) }}</span><button class="btn btn-sm" @click="open(run.id)">{{ t('interactions.view') }}</button></div>
        <p v-if="run.error" class="interaction-error">{{ run.error }}</p>
      </article>
      <button v-if="cursor" class="btn" :disabled="loading" @click="reload(true)">{{ t('interactions.more') }}</button>
    </div>
    <template v-else>
      <div class="interaction-detail-head">
        <button class="btn btn-sm" @click="selected = null; events = []">{{ t('interactions.back') }}</button>
        <span>{{ sourceLabel(selected.source) }} · {{ t('interactions.' + selected.status) }} · {{ duration(selected) }}</span>
        <button v-if="!following" class="btn btn-sm" @click="resumeFollowing">{{ t('interactions.follow') }}</button>
      </div>
      <p class="interaction-notice">{{ t('interactions.availability') }}</p>
      <div ref="timeline" class="interaction-events" @scroll="onScroll">
        <details v-for="step in steps" :key="step.id" class="interaction-step" :class="{ 'is-error': step.type === 'error' || step.data?.is_error || step.data?.isError }" @toggle="toggleStep(step.id, $event)">
          <summary>
            <time>{{ time(step.created_at) }}</time>
            <strong>{{ eventLabel(step.type) }}</strong>
            <span v-if="step.count > 1"> × {{ step.count }}</span>
            <span class="interaction-step-elapsed">{{ elapsed(step.created_at) }}<template v-if="step.data?.elapsed_ms != null"> · {{ Math.round(step.data.elapsed_ms) }}ms</template></span>
            <span class="interaction-summary">{{ summary(step) }}</span>
          </summary>
          <div class="interaction-meta">{{ step.run_id }} · #{{ step.id }}</div>
          <pre v-if="expanded.has(step.id)">{{ detail(step) }}</pre>
        </details>
        <div v-for="asset in assets" :key="asset.id" class="interaction-asset">
          <video v-if="asset.service_type === 'video'" :src="mediaUrl(asset.result_url)" controls preload="metadata" />
          <img v-else :src="mediaUrl(asset.result_url)" :alt="t('interactions.result')" loading="lazy" />
        </div>
        <p v-if="!events.length" class="interaction-notice">{{ t('interactions.emptyEvents') }}</p>
      </div>
    </template>
  </section>
</template>

<script setup lang="ts">
import { api } from '~/composables/useApi'
import { useI18n } from 'vue-i18n'
import { groupRunEvents } from '~/utils/interaction-timeline.mjs'
const props = defineProps<{ episodeId: number; initialRunId?: string }>()
const { t, te } = useI18n()
const statuses = ['running', 'completed', 'failed', 'interrupted']
const kind = ref(''), status = ref(''), runs = ref<any[]>([]), events = ref<any[]>([]), selected = ref<any>(null)
const cursor = ref<string | null>(null), loading = ref(false), error = ref(''), confirmClear = ref(false), connected = ref(false)
const timeline = ref<HTMLElement>(), following = ref(true), now = ref(Date.now())
const expanded = ref(new Set<number>())
let stream: EventSource | undefined, refreshTimer: ReturnType<typeof setTimeout> | undefined, ticker: ReturnType<typeof setInterval> | undefined
let generation = 0, listRequest = 0, disposed = false, detailLoading = false, detailAgain = false
function time(value: string) { return new Date(value).toLocaleString() }
function modelLabel(value: string) { return value === 'default' ? t('codex.defaultModel') : value || '' }
function providerLabel(run: any) { return run.models?.length ? run.models.map((m: any) => `${m.provider} ${modelLabel(m.model)}`).join(' / ') : run.provider ? `${run.provider} ${modelLabel(run.model)}` : t(run.status === 'running' ? 'interactions.pendingProvider' : 'interactions.notProvided') }
function duration(run: any) { return `${Math.max(0, Math.round(((run.finished_at ? Date.parse(run.finished_at) : now.value) - Date.parse(run.started_at)) / 1000))}s` }
function elapsed(value: string) { return `+${Math.max(0, (Date.parse(value) - Date.parse(selected.value?.started_at)) / 1000).toFixed(1)}s` }
function sourceLabel(value: string) { const key = 'interactions.sources.' + value; return te(key) ? t(key) : value }
function eventLabel(value: string) { const key = 'interactions.events.' + value; return te(key) ? t(key) : value }
function mediaUrl(value: string) { return value?.startsWith('static/') ? '/' + value : value }
const assets = computed(() => (selected.value?.children || []).filter((run: any) => run.result_url && ['image', 'video'].includes(run.service_type)))
const steps = computed(() => groupRunEvents(events.value))
function summary(step: any) {
  const data = step.data || {}
  if (step.type === 'usage') return step.raw[0].data == null ? t('interactions.notProvided') : Object.entries(data).filter(([, value]) => typeof value === 'number').map(([key, value]) => `${key}: ${value}`).join(' · ')
  if (data.error || data.is_error || data.isError) return `${data.tool_name || data.toolName || ''} ${typeof data.error === 'string' ? data.error : data.error?.message || JSON.stringify(data.result || data.error || '')}`.trim().slice(0, 180)
  const value = data.text || data.tool_name || data.toolName || data.url || data.prompt || data.model || data.messages?.at(-1)?.content || (statuses.includes(data.status) ? t('interactions.' + data.status) : data.status) || ''
  return (typeof value === 'string' ? value : JSON.stringify(value)).slice(0, 180)
}
function detail(step: any) {
  if (step.raw[0].data == null) return t('interactions.notProvided')
  if (step.type === 'model-output') return step.data.text || ''
  return JSON.stringify(step.raw.length > 1 ? step.raw : step.raw[0].data, null, 2).replaceAll('"not_provided"', JSON.stringify(t('interactions.notProvided')))
}
function toggleStep(id: number, event: Event) { const next = new Set(expanded.value); (event.target as HTMLDetailsElement).open ? next.add(id) : next.delete(id); expanded.value = next }
function onScroll() { const el = timeline.value; if (el) following.value = el.scrollHeight - el.scrollTop - el.clientHeight < 60 }
async function follow() { await nextTick(); if (following.value && timeline.value) timeline.value.scrollTop = timeline.value.scrollHeight }
function resumeFollowing() { following.value = true; void follow() }
async function loadDetail() {
  if (!selected.value) return
  if (detailLoading) { detailAgain = true; return }
  detailLoading = true
  const id = selected.value.id, revision = generation
  try {
    const run = await api.get(`/ai-runs/${id}`)
    let after = events.value.at(-1)?.id || 0, next: number | null
    do {
      const page = await api.get(`/ai-runs/${id}/events?after_id=${after}&limit=500`)
      if (disposed || generation !== revision || selected.value?.id !== id) return
      const existing = new Set(events.value.map(e => e.id))
      events.value.push(...page.items.filter((e: any) => !existing.has(e.id)))
      next = page.next_cursor; if (next) after = next
    } while (next)
    if (selected.value?.id === id && generation === revision) { selected.value = run; await follow() }
  } catch (e: any) { if (!disposed && generation === revision) error.value = e.message }
  finally { detailLoading = false; if (detailAgain) { detailAgain = false; void loadDetail() } }
}
async function open(id: string) { selected.value = { id, source: '', status: 'running', started_at: new Date().toISOString() }; events.value = []; expanded.value = new Set(); following.value = true; await loadDetail() }
async function reload(more = false, subscribe = false) {
  const revision = generation, request = ++listRequest
  loading.value = true
  try {
    const params = new URLSearchParams({ episode_id: String(props.episodeId), limit: '50' })
    if (kind.value) params.set('service_type', kind.value)
    if (status.value) params.set('status', status.value)
    if (more && cursor.value) params.set('cursor', cursor.value)
    const page = await api.get(`/ai-runs?${params}`)
    if (disposed || generation !== revision || request !== listRequest) return
    if (more) { const ids = new Set(runs.value.map(r => r.id)); runs.value.push(...page.items.filter((r: any) => !ids.has(r.id))) }
    else runs.value = page.items
    cursor.value = page.next_cursor; error.value = ''
    if (subscribe) connect(page.event_cursor)
  } catch (e: any) { if (generation === revision && request === listRequest) error.value = e.message }
  finally { if (generation === revision && request === listRequest) loading.value = false }
}
function connect(after: number) {
  stream?.close()
  stream = new EventSource(`/api/v1/ai-runs/stream?episode_id=${props.episodeId}&after_id=${after}`)
  stream.onopen = () => { connected.value = true; void reload(); void loadDetail() }
  stream.onerror = () => { connected.value = false }
  stream.addEventListener('interaction', () => {
    if (!refreshTimer) refreshTimer = setTimeout(() => { refreshTimer = undefined; void reload(); void loadDetail() }, 100)
  })
}
async function clearHistory() { try { await api.del(`/ai-runs?episode_id=${props.episodeId}`); selected.value = null; events.value = []; confirmClear.value = false; await reload() } catch (e: any) { error.value = e.message } }
watch([kind, status], () => { void reload() })
watch(() => props.episodeId, () => { generation++; stream?.close(); selected.value = null; events.value = []; runs.value = []; connected.value = false; void reload(false, true) })
onMounted(async () => { ticker = setInterval(() => { now.value = Date.now() }, 1000); await reload(false, true); if (props.initialRunId) await open(props.initialRunId) })
onUnmounted(() => { disposed = true; generation++; stream?.close(); if (refreshTimer) clearTimeout(refreshTimer); if (ticker) clearInterval(ticker) })
</script>

<style scoped>
.interaction-center { display:flex; flex-direction:column; flex:1; min-height:0; overflow:hidden; }
.interaction-filters,.interaction-detail-head,.interaction-row { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
.interaction-filters,.interaction-detail-head { padding:12px 16px; border-bottom:1px solid var(--border); }
.interaction-filters .input { width:auto; flex:1; min-width:100px; }
.interaction-list,.interaction-events { padding:12px 16px; overflow:auto; flex:1; min-height:0; }
.interaction-run { padding:14px 0; border-bottom:1px solid var(--border); }
.interaction-meta,.interaction-notice,.interaction-tag,time,.interaction-step-elapsed { color:var(--text-2); font-size:12px; }
.interaction-notice { padding:8px 16px; margin:0; }
.interaction-meta { margin:7px 0; overflow-wrap:anywhere; }
.interaction-tag { margin-left:8px; }
.interaction-row { justify-content:space-between; }
.interaction-status.is-completed { color:var(--success); }
.interaction-status.is-failed,.interaction-error,.is-error strong { color:var(--action-danger); }
.interaction-status.is-running { color:var(--accent); }
.interaction-step { border-left:2px solid var(--border); padding:10px 12px; margin:6px 0; }
.interaction-step summary { cursor:pointer; line-height:1.6; }
.interaction-step strong { margin:0 8px; }
.interaction-summary { display:block; white-space:pre-wrap; overflow-wrap:anywhere; font-size:13px; }
pre { white-space:pre-wrap; overflow-wrap:anywhere; font-size:12px; line-height:1.7; background:var(--bg-2); border-radius:8px; padding:12px; margin:8px 0; }
.interaction-asset img,.interaction-asset video { width:100%; max-height:360px; object-fit:contain; margin:12px 0; }
</style>
