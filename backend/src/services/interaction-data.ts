/** Trace payloads preserve prose, but never persist credentials or binary media. */
const secretKey = /^(authorization|proxy-authorization|cookie|set-cookie|(?:x[-_](?:[a-z]+[-_])?)?api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|token|password|secret|client_secret)$/i
const binaryKey = /^(b64_json|base64|audiohex|bytes)$/i

function safeUrl(value: string): string {
  try {
    const url = new URL(value)
    url.username = ''
    url.password = ''
    for (const key of [...url.searchParams.keys()]) {
      if (secretKey.test(key) || /^(key|signature|sig|credential|x-amz-signature|x-amz-credential|x-amz-security-token|x-goog-signature|x-goog-credential)$/i.test(key)) url.searchParams.set(key, '[redacted]')
    }
    return url.toString()
  } catch { return value }
}

function safeString(value: string): unknown {
  if (/^data:[^;,]+;base64,/i.test(value)) {
    const comma = value.indexOf(',')
    return { omitted: 'binary', mime_type: value.slice(5, value.indexOf(';')), encoded_length: value.length - comma - 1 }
  }
  // Tool results and provider errors sometimes embed structured data as a JSON string.
  if (/^\s*[\[{]/.test(value)) {
    try { return JSON.stringify(interactionData(JSON.parse(value))) } catch {}
  }
  const redacted = value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{16,}/g, '[redacted]')
  return redacted.replace(/data:[^;,\s]+;base64,[A-Za-z0-9+/=]+/gi, media => JSON.stringify({ omitted: 'binary', encoded_length: media.length - media.indexOf(',') - 1 }))
    .replace(/https?:\/\/[^\s"<>]+/g, safeUrl)
}

export function interactionData(value: unknown, seen = new WeakSet<object>()): any {
  if (typeof value === 'string') return safeString(value)
  if (typeof value === 'bigint') return String(value)
  if (value == null || typeof value !== 'object') return value
  if (value instanceof Error) return { name: value.name, message: safeString(value.message) }
  if (value instanceof Uint8Array) return { omitted: 'binary', bytes: value.byteLength }
  if (value instanceof Blob) return { omitted: 'binary', mime_type: value.type, bytes: value.size, name: (value as File).name }
  if (seen.has(value)) return '[circular]'
  seen.add(value)
  try {
    if (value instanceof Headers) return interactionData(Object.fromEntries(value.entries()), seen)
    if (value instanceof FormData) return [...value.entries()].map(([key, item]) => ({ key, value: secretKey.test(key) ? '[redacted]' : interactionData(item, seen) }))
    if (Array.isArray(value)) return value.map(item => interactionData(item, seen))
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) {
      if (secretKey.test(key)) out[key] = '[redacted]'
      else if (binaryKey.test(key) || (key === 'data' && typeof item === 'string' && ('mimeType' in value || 'mime_type' in value))) {
        out[key] = { omitted: 'binary', encoded_length: typeof item === 'string' ? item.length : undefined }
      } else out[key] = interactionData(item, seen)
    }
    return out
  } finally { seen.delete(value) }
}
