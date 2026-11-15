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
      failed: m.status?.failed === true || m.status?.value === 'failed',
      ctx: Number(flag(a, '--ctx-size')) || null,
      file: file ?? null,
      sha: file?.match(/\/snapshots\/([^/]+)\//)?.[1] ?? null,
    }
  })
}
/**
 * One chat completion. The first six arguments are the old positional signature; `opts` is new:
 *   opts.chat_template_kwargs  passed through to the request body, for example {enable_thinking:false}.
 * A reply with no content because the token cap was spent (finish_reason=length, as a thinking model does inside reasoning_content)
 * returns {text:'', truncated:true} instead of throwing: it is a result about the model, not a server fault.
 */
export async function chat(base, model, messages, timeoutMs = 180000, maxTokens = 200, abort, opts = {}) {
  const t0 = Date.now()
  const body = { model, messages, temperature: 0, max_tokens: maxTokens }
  if (opts?.chat_template_kwargs) body.chat_template_kwargs = opts.chat_template_kwargs
  const res = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: abort ? AbortSignal.any([AbortSignal.timeout(timeoutMs), abort]) : AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) throw new Error(`chat: HTTP ${res.status}`)
  const choice = (await res.json())?.choices?.[0]
  const text = choice?.message?.content
  if (choice?.finish_reason === 'length' && (text === undefined || text === null || text === '')) return { text: '', ms: Date.now() - t0, truncated: true }
  if (typeof text !== 'string') throw new Error('chat: no content')
  return { text, ms: Date.now() - t0, finish: choice?.finish_reason }
}

/**
 * Wait for a model to load, as a loop of short requests. Node's fetch (undici) gives up on response headers after 300 s and an
 * AbortSignal cannot raise that, so one long warm-up request dies on a slow cold load. Each request here is capped at `requestMs`
 * (default 120 s), well under it. A model the server reports as loading is polled without a request; anything else gets a tiny
 * chat (max_tokens 8), which also starts the load. Resolves with elapsed seconds; rejects with the last cause once `timeoutMs` passes.
 */
export async function warmUp(base, model, { timeoutMs = 40 * 60000, requestMs = 120000, pollMs = 5000, opts, abort, listModels: list = listModels, chat: ask = chat, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now } = {}) {
  const t0 = now()
  let cause = 'no attempt made', sent = false
  for (;;) {
    if (abort?.aborted) throw new Error('warm-up: interrupted')
    const left = timeoutMs - (now() - t0)
    if (left <= 0) throw new Error(`warm-up: ${model} not ready after ${Math.round(timeoutMs / 1000)} s (${cause})`)
    let fatal = null
    try {
      const row = (await list(base, 5000)).find((m) => m.id === model)
      const status = row?.status
      if (!row) fatal = `warm-up: ${model} is not served at ${base}`
      // A router can keep `failed` from an earlier load until the next attempt starts, so it is believed only after this warm-up has sent a request.
      else if (row.failed && sent) fatal = `warm-up: the server reports ${model} failed to load`
      else if (status === 'loading') cause = 'still loading'
      else {
        sent = true
        await ask(base, model, [{ role: 'user', content: 'ok' }], Math.min(requestMs, left), 8, abort, opts)
        return Math.round((now() - t0) / 1000)
      }
    } catch (e) { cause = String(e?.cause?.code ?? e?.message ?? e).slice(0, 120) }
    if (fatal) throw new Error(fatal) // not retried: a missing or failed model will not come up by waiting
    await sleep(Math.min(pollMs, Math.max(0, timeoutMs - (now() - t0))))
  }
}
export async function unload(base, model) {
  try {
    await fetch(`${base}/models/unload`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model }), signal: AbortSignal.timeout(5000) })
    return true
  } catch { return false }
}
