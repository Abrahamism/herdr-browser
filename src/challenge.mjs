/**
 * Bot challenges: recognize them, never solve them.
 *
 * A protected page that hands back a Cloudflare, Akamai, DataDome, PerimeterX, Imperva or
 * AWS WAF interstitial is not the page the caller asked for. Reporting it is the difference
 * between an agent that knows it is blocked and an agent that reasons about an empty page.
 */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Hard interstitials require two signals - title AND text - on purpose: a blog post that
 * mentions Cloudflare in its body must not look like a challenge.
 */
export const CHALLENGE_SIGNATURES = [
  {
    kind: 'cloudflare',
    // A bare brand name in the title is a blog post, not a challenge: the interstitials
    // that matter are titled `Just a moment...` or `Attention Required! | Cloudflare`.
    title: /just a moment|attention required|please wait|un momento/i,
    text: /checking your browser|verifying you are human|verify you are human|enable javascript and cookies|cf-browser-verification|ray id|verificando/i
  },
  {
    kind: 'akamai',
    title: /access denied|reference #|acceso denegado/i,
    text: /akamai|reference #\d|errors\.edgesuite\.net|you don't have permission to access/i
  },
  {
    kind: 'datadome',
    title: /blocked|datadome|acceso bloqueado/i,
    text: /captcha-delivery\.com|datadome-captcha|enable js and disable any ad blocker/i
  },
  {
    kind: 'perimeterx',
    title: /access to this page has been denied|are you a robot|px-captcha/i,
    text: /perimeterx|_px2|please verify you are a human/i
  },
  {
    kind: 'imperva',
    title: /attention required|access denied|incapsula|request unsuccessful/i,
    text: /incapsula|_incapsula_resource|request unsuccessful/i
  },
  {
    kind: 'awswaf',
    title: /human verification|verificaci[oó]n humana|aws/i,
    text: /awswaf|verify that you are a human|captcha container/i
  },
  {
    kind: 'access-denied',
    title: /^\s*403|forbidden|access denied|acceso denegado|sin autorizaci[oó]n/i,
    text: /you don't have permission|request blocked|unusual traffic|no tienes permiso/i
  }
]

/** A CAPTCHA widget mounted on an otherwise normal page: one marker is enough. */
export const CAPTCHA_MARKERS = [
  { marker: 'turnstile', label: 'Cloudflare Turnstile' },
  { marker: 'recaptcha', label: 'reCAPTCHA' },
  { marker: 'hcaptcha', label: 'hCaptcha' },
  { marker: 'perimeterx', label: 'PerimeterX' },
  { marker: 'datadome', label: 'DataDome' }
]

/** Pure: decide from what the page reports. Returns `{kind, signal}` or null. */
export function detectChallenge(page) {
  const title = String(page?.title ?? '')
  const text = String(page?.text ?? '').slice(0, 4000)
  const markers = page?.markers ?? {}

  for (const signature of CHALLENGE_SIGNATURES) {
    if (!signature.title.test(title)) continue
    if (!signature.text.test(text)) continue
    return { kind: signature.kind, signal: 'title and text' }
  }

  for (const entry of CAPTCHA_MARKERS) {
    if (markers[entry.marker]) return { kind: 'captcha', signal: `${entry.label} widget` }
  }

  return null
}

/** One round trip: title, a bounded slice of text, and the widgets that can be mounted. */
export function challengeProbeScript() {
  return `(() => { /*__hbChallenge*/
  const has = (selector) => Boolean(document.querySelector(selector));
  return {
    title: document.title,
    url: location.href,
    text: document.body ? document.body.innerText.slice(0, 4000) : '',
    markers: {
      turnstile: has('iframe[src*="challenges.cloudflare.com"]'),
      recaptcha: has('iframe[src*="recaptcha"], .g-recaptcha'),
      hcaptcha: has('iframe[src*="hcaptcha"], .h-captcha'),
      perimeterx: has('iframe[src*="captcha.px-cdn.net"], #px-captcha'),
      datadome: has('iframe[src*="captcha-delivery.com"]')
    }
  };
})()`
}

/**
 * Wait for a challenge the browser clears by itself. A challenge that survives the whole
 * budget is returned as-is: the caller reports it and hands the page to a person.
 */
export async function waitOutChallenge({ waitMs = 15_000, intervalMs = 1000, evaluate } = {}) {
  if (typeof evaluate !== 'function') throw new Error('waitOutChallenge needs an evaluate function')
  const probe = async () => {
    const page = await evaluate(challengeProbeScript())
    return { page, challenge: detectChallenge(page) }
  }

  let { page, challenge } = await probe()
  if (!challenge) return { challenge: null, cleared: false, waitedMs: 0, page }
  if (waitMs <= 0) return { challenge, cleared: false, waitedMs: 0, page }

  const started = Date.now()
  const deadline = started + waitMs
  for (;;) {
    if (Date.now() >= deadline) break
    await sleep(Math.min(intervalMs, Math.max(0, deadline - Date.now())))
    // A page that navigates while a challenge is up tears the context down; keep polling.
    try {
      ;({ page, challenge } = await probe())
    } catch {
      continue
    }
    if (!challenge) return { challenge: null, cleared: true, waitedMs: Date.now() - started, page }
  }
  return { challenge, cleared: false, waitedMs: Date.now() - started, page }
}
