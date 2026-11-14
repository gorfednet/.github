// OpenAI-style client for Llama.app. Local only; never calls a hosted API.
export const DEFAULT_BASE = process.env.LOCAL_LLM_URL || 'http://127.0.0.1:9931'
const flag = (a, name) => (a.includes(name) ? a[a.indexOf(name) + 1] : undefined)
/** GET /v1/models, normalised to {id, status, ctx, file, sha}. sha is the snapshot revision in the path. */
export async function listModels(base = DEFAULT_BASE, timeoutMs = 2000) {
  const res = await fetch(`${base}/v1/models`, { signal: AbortSignal.timeout(timeoutMs) })
  if (!res.ok) throw new Error(`models: HTTP ${res.status}`)
  const body = await res.json()
  if (!Array.isArray(body?.data)) throw new Error('models: unexpected body')
  return body.data.map((m) => {
    const a = m.status?.args ?? []
    const file = flag(a, '--model')
    return {
      id: m.id,
      status: m.status?.value ?? 'unknown',
      ctx: Number(flag(a, '--ctx-size')) || null,
      file: file ?? null,
      sha: file?.match(/\/snapshots\/([^/]+)\//)?.[1] ?? null,
    }
  })
}
export async function chat(base, model, messages, timeoutMs = 180000) {
  const t0 = Date.now()
  const res = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, messages, temperature: 0, max_tokens: 200 }),
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) throw new Error(`chat: HTTP ${res.status}`)
  const text = (await res.json())?.choices?.[0]?.message?.content
  if (typeof text !== 'string') throw new Error('chat: no content')
  return { text, ms: Date.now() - t0 }
}
export async function unload(base, model) {
  try {
    await fetch(`${base}/models/unload`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model }), signal: AbortSignal.timeout(5000) })
    return true
  } catch { return false }
}
