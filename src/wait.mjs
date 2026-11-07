/**
 * Waiting for the page to reach a state.
 *
 * The caller blocks and the condition is evaluated through CDP in the page itself:
 * no extension, no event lane, no process left behind. A timeout is never reported as
 * success - the command exits non-zero and says what it actually observed.
 */

export const WAIT_KINDS = ['selector', 'text', 'url']

const SPEC_PATTERN = /^(selector|text|url)\s*[=:]\s*([\s\S]*)$/

export function parseWaitSpec(spec) {
  const text = String(spec ?? '').trim()
  if (!text) {
    throw new Error('--for needs a condition: selector=<css>, text=<substring> or url=<substring>')
  }
  const match = SPEC_PATTERN.exec(text)
  if (!match) {
    throw new Error(`invalid --for "${text}" (use selector=<css>, text=<substring> or url=<substring>)`)
  }
  const value = match[2].trim()
  if (!value) throw new Error(`--for "${text}" has an empty value`)
  return { kind: match[1], value }
}

const DURATION_PATTERN = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/i
const UNIT_MS = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }

/** `500` is milliseconds; `30s` and `5m` are conveniences. */
export function parseDuration(value, fallbackMs) {
  if (value === undefined || value === null || value === '') return fallbackMs
  const raw = String(value).trim()
  const match = DURATION_PATTERN.exec(raw)
  if (!match) throw new Error(`invalid duration "${raw}" (use 500, 500ms, 30s or 5m)`)
  const unit = (match[2] ?? 'ms').toLowerCase()
  const ms = Math.round(Number.parseFloat(match[1]) * UNIT_MS[unit])
  if (!Number.isFinite(ms)) throw new Error(`invalid duration "${raw}"`)
  return ms
}

/**
 * The condition as an expression the page answers in one round trip.
 * The marker comment lets the test double recognise its own probes.
 */
export function conditionScript({ kind, value }) {
  const literal = JSON.stringify(value)
  if (kind === 'selector') {
    return `(() => { /*__hbWait*/
  const element = document.querySelector(${literal});
  const rendered = Boolean(element && element.getClientRects().length);
  return {
    ok: rendered,
    detail: element
      ? (rendered ? 'the element is rendered' : 'the element exists but is not rendered')
      : 'no element matches',
    url: location.href,
    title: document.title
  };
})()`
  }
  if (kind === 'text') {
    return `(() => { /*__hbWait*/
  const body = document.body ? document.body.innerText : '';
  const found = body.includes(${literal});
  return { ok: found, detail: found ? 'the text is present' : 'the text is not present', url: location.href, title: document.title };
})()`
  }
  if (kind === 'url') {
    return `(() => { /*__hbWait*/
  const found = location.href.includes(${literal});
  return { ok: found, detail: found ? 'the url matches' : 'the url does not match', url: location.href, title: document.title };
})()`
  }
  throw new Error(`unknown wait condition "${kind}"`)
}

export function describeCondition(condition) {
  return condition ? `${condition.kind}=${condition.value}` : 'the page to navigate'
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Poll until the condition holds or the budget runs out. The first probe always runs,
 * so a zero budget means "check now and tell me".
 */
export async function waitForCondition(
  cdp,
  sessionId,
  condition,
  { timeoutMs = 30_000, intervalMs = 200, evaluate } = {}
) {
  if (typeof evaluate !== 'function') throw new Error('waitForCondition needs an evaluate function')
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new Error('timeout must be zero or more')
  const script = conditionScript(condition)
  const started = Date.now()
  const deadline = started + timeoutMs
  let last = { ok: false, detail: 'not evaluated', url: null, title: null }
  let lastError = null

  for (;;) {
    try {
      const probe = await evaluate(script)
      if (probe && typeof probe === 'object') last = { ...last, ...probe }
      lastError = null
    } catch (error) {
      // A navigation between two probes tears the context down; keep polling.
      lastError = error
    }
    const waitedMs = Date.now() - started
    if (last.ok) {
      return {
        ok: true,
        timedOut: false,
        waitedMs,
        condition,
        url: last.url ?? null,
        title: last.title ?? null,
        detail: last.detail ?? null
      }
    }
    if (Date.now() >= deadline) {
      return {
        ok: false,
        timedOut: true,
        waitedMs,
        condition,
        url: last.url ?? null,
        title: last.title ?? null,
        detail: lastError ? `the last probe failed: ${lastError.message}` : (last.detail ?? null)
      }
    }
    await sleep(Math.min(intervalMs, Math.max(0, deadline - Date.now())))
  }
}

/**
 * Block until the human finishes their part. Without an explicit condition the signal is
 * navigation: the page the person was working on is no longer the one we left them on.
 */
export async function handoff(
  cdp,
  sessionId,
  { condition = null, message = null, timeoutMs = 300_000, intervalMs = 250, evaluate } = {}
) {
  if (typeof evaluate !== 'function') throw new Error('handoff needs an evaluate function')
  const baselineUrl = await evaluate('location.href')

  if (condition) {
    const result = await waitForCondition(cdp, sessionId, condition, { timeoutMs, intervalMs, evaluate })
    return { ...result, baselineUrl: baselineUrl ?? null, message }
  }

  const started = Date.now()
  const deadline = started + timeoutMs
  let lastUrl = baselineUrl ?? null
  for (;;) {
    const current = await evaluate('location.href')
    if (typeof current === 'string') lastUrl = current
    const waitedMs = Date.now() - started
    if (typeof current === 'string' && current !== baselineUrl) {
      return {
        ok: true,
        timedOut: false,
        waitedMs,
        condition: null,
        url: current,
        title: null,
        detail: 'the page navigated',
        baselineUrl: baselineUrl ?? null,
        message
      }
    }
    if (Date.now() >= deadline) {
      return {
        ok: false,
        timedOut: true,
        waitedMs,
        condition: null,
        url: lastUrl,
        title: null,
        detail: 'the page never navigated',
        baselineUrl: baselineUrl ?? null,
        message
      }
    }
    await sleep(Math.min(intervalMs, Math.max(0, deadline - Date.now())))
  }
}
