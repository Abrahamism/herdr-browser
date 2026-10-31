import { createHash } from 'node:crypto'
import { CURSOR_SCRIPT, fillScript, resolveRefScript, snapshotScript } from './inject.mjs'

const MODIFIERS = { Alt: 1, Control: 2, Meta: 4, Shift: 8 }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const SPECIAL_KEYS = {
  Enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  Space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  Home: { key: 'Home', code: 'Home', keyCode: 36 },
  End: { key: 'End', code: 'End', keyCode: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', keyCode: 34 }
}

function keyDescriptor(name) {
  if (SPECIAL_KEYS[name]) return SPECIAL_KEYS[name]
  if (/^[a-zA-Z]$/.test(name)) {
    const upper = name.toUpperCase()
    return { key: name, code: `Key${upper}`, keyCode: upper.charCodeAt(0) }
  }
  if (/^[0-9]$/.test(name)) return { key: name, code: `Digit${name}`, keyCode: name.charCodeAt(0) }
  if (name.length === 1) return { key: name, code: '', keyCode: 0 }
  throw new Error(`unsupported key "${name}"`)
}

/** Parse "Control+Shift+A" / "Enter" into CDP key event fields. Pure; used by tests. */
export function parseKeyCombo(combo) {
  const parts = String(combo).split('+').filter(Boolean)
  if (!parts.length) throw new Error('empty key combination')
  const keyName = parts.pop()
  let modifiers = 0
  for (const part of parts) {
    const canonical = Object.keys(MODIFIERS).find((name) => name.toLowerCase() === part.toLowerCase())
    if (!canonical) throw new Error(`unknown modifier "${part}"`)
    modifiers |= MODIFIERS[canonical]
  }
  const descriptor = keyDescriptor(keyName)
  return { ...descriptor, modifiers, text: modifiers ? undefined : descriptor.text }
}

/** `e1` is the main document; `f1e2` is ref e2 inside the first child frame. */
export function parseRef(ref) {
  const match = /^(?:f(\d+))?(e\d+)$/.exec(String(ref))
  if (!match) throw new Error(`invalid ref "${ref}" (expected e1 or f1e1)`)
  return { frame: match[1] ? Number.parseInt(match[1], 10) : 0, local: match[2] }
}

async function evaluate(cdp, sessionId, expression, { awaitPromise = false, timeoutMs, contextId } = {}) {
  const params = { expression, returnByValue: true, awaitPromise }
  if (contextId !== undefined) params.contextId = contextId
  const response = await cdp.send('Runtime.evaluate', params, { sessionId, timeoutMs })
  if (response.exceptionDetails) {
    const detail = response.exceptionDetails.exception?.description ?? response.exceptionDetails.text
    throw new Error(`page error: ${detail}`)
  }
  return response.result?.value
}

/** Default execution contexts for a session, keyed by frame id. */
async function sessionContexts(cdp, sessionId) {
  const defaults = new Map()
  const stop = cdp.on(
    'Runtime.executionContextCreated',
    (params) => {
      const context = params.context
      if (context?.auxData?.isDefault) defaults.set(context.auxData.frameId, context.id)
    },
    { sessionId }
  )
  await cdp.send('Runtime.enable', {}, { sessionId })
  await sleep(60)
  stop()
  return defaults
}

async function contextFor(cdp, sessionId, frameId, defaults, worldName) {
  if (defaults.get(frameId) !== undefined) return defaults.get(frameId)
  const { executionContextId } = await cdp.send(
    'Page.createIsolatedWorld',
    { frameId, worldName },
    { sessionId }
  )
  return executionContextId
}

/**
 * Every frame reachable from a page: the main document, same-process children,
 * and out-of-process iframes (OOPIFs), which Chrome exposes as their own target
 * and which `Page.getFrameTree` does not list under the page.
 * Index 0 is the main document; the rest get `f1`, `f2`… ref prefixes.
 */
export async function frameContexts(cdp, pageSessionId, pageTargetId) {
  await cdp.send('Page.enable', {}, { sessionId: pageSessionId })
  const mainDefaults = await sessionContexts(cdp, pageSessionId)
  const { frameTree } = await cdp.send('Page.getFrameTree', {}, { sessionId: pageSessionId })

  const entries = []
  const walk = (node) => {
    entries.push({ frame: node.frame, sessionId: pageSessionId, defaults: mainDefaults })
    for (const child of node.childFrames ?? []) walk(child)
  }
  if (frameTree) walk(frameTree)

  const { targetInfos } = await cdp.send('Target.getTargets')
  for (const target of targetInfos) {
    if (target.type !== 'iframe' || target.targetId === pageTargetId) continue
    try {
      const sessionId = await cdp.attach(target.targetId)
      await cdp.send('Page.enable', {}, { sessionId })
      const defaults = await sessionContexts(cdp, sessionId)
      const tree = await cdp.send('Page.getFrameTree', {}, { sessionId })
      if (tree.frameTree) entries.push({ frame: tree.frameTree.frame, sessionId, defaults })
    } catch {
      // A frame target that disappeared between listing and attaching is skipped.
    }
  }

  const contexts = []
  for (const [index, entry] of entries.entries()) {
    try {
      const contextId = await contextFor(cdp, entry.sessionId, entry.frame.id, entry.defaults, `herdr-browser-${index}`)
      contexts.push({ index, frame: entry.frame, sessionId: entry.sessionId, contextId })
    } catch {
      if (index === 0) throw new Error('cannot open an execution context for the main frame')
    }
  }
  return contexts
}

/** Content-box origin of a child frame, in main-frame viewport coordinates. */
async function frameOffset(cdp, pageSessionId, frameId) {
  await cdp.send('DOM.enable', {}, { sessionId: pageSessionId })
  const { backendNodeId } = await cdp.send('DOM.getFrameOwner', { frameId }, { sessionId: pageSessionId })
  const { model } = await cdp.send('DOM.getBoxModel', { backendNodeId }, { sessionId: pageSessionId })
  const [x, y] = model.content
  return { x, y }
}

/** Interpolated points for a visible pointer move. Pure; asserted by tests. */
export function moveSteps(from, to, steps = 12) {
  const path = []
  for (let index = 1; index <= steps; index += 1) {
    path.push({
      x: from.x + ((to.x - from.x) * index) / steps,
      y: from.y + ((to.y - from.y) * index) / steps
    })
  }
  return path
}

async function moveCursor(cdp, pageSessionId, to, { steps = 12, durationMs = 300 } = {}) {
  const from =
    (await evaluate(
      cdp,
      pageSessionId,
      'window.__hbPos || { x: innerWidth / 2, y: innerHeight / 2 }'
    )) ?? { x: to.x, y: to.y }
  for (const point of moveSteps(from, to, steps)) {
    await cdp.send(
      'Input.dispatchMouseEvent',
      { type: 'mouseMoved', x: point.x, y: point.y },
      { sessionId: pageSessionId }
    )
    // Paint in the top document too: events over an iframe never reach its listeners.
    try {
      await evaluate(cdp, pageSessionId, `window.__hbPaint && window.__hbPaint(${point.x}, ${point.y})`)
    } catch {
      // The page may be navigating; the next move repaints.
    }
    await sleep(durationMs / steps)
  }
  return to
}

export async function preparePage(cdp, targetId, { cursor = true } = {}) {
  const sessionId = await cdp.attach(targetId)
  cdp.prepared ??= new Set()
  if (!cdp.prepared.has(sessionId)) {
    await cdp.send('Page.enable', {}, { sessionId })
    await cdp.send('Runtime.enable', {}, { sessionId })
    if (cursor) {
      await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: CURSOR_SCRIPT }, { sessionId })
    }
    cdp.prepared.add(sessionId)
  }
  if (cursor) await evaluate(cdp, sessionId, CURSOR_SCRIPT)
  return sessionId
}

export async function navigate(cdp, sessionId, url) {
  const { errorText } = await cdp.send('Page.navigate', { url }, { sessionId, timeoutMs: 45_000 })
  if (errorText) throw new Error(`navigation failed: ${errorText}`)
  await waitForLoad(cdp, sessionId)
}

async function waitForLoad(cdp, sessionId, { timeoutMs = 20_000 } = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const state = await evaluate(cdp, sessionId, 'document.readyState')
    if (state === 'complete' || state === 'interactive') return
    await sleep(100)
  }
}

/** Snapshot of every frame, with refs prefixed by frame (`f1e2`). */
export async function snapshot(cdp, pageSessionId, pageTargetId) {
  const frames = await frameContexts(cdp, pageSessionId, pageTargetId)
  const items = []
  const info = []
  for (const { index, frame, sessionId, contextId } of frames) {
    try {
      const data = await evaluate(cdp, sessionId, snapshotScript(), { contextId, timeoutMs: 15_000 })
      const prefix = index === 0 ? '' : `f${index}`
      info.push({ index, url: data.url || frame.url, title: data.title, count: data.items.length })
      for (const item of data.items) items.push({ ...item, ref: `${prefix}${item.ref}`, frame: index })
    } catch (error) {
      info.push({ index, url: frame.url, error: error.message, count: 0 })
    }
  }
  const main = info.find((entry) => entry.index === 0) ?? { title: '', url: '' }
  return { title: main.title, url: main.url, items, frames: info }
}

async function resolveTarget(cdp, pageSessionId, pageTargetId, ref) {
  const { frame, local } = parseRef(ref)
  const frames = await frameContexts(cdp, pageSessionId, pageTargetId)
  const target = frames.find((entry) => entry.index === frame)
  if (!target) throw new Error(`frame ${frame} is not available; run snapshot again`)
  const point = await evaluate(cdp, target.sessionId, resolveRefScript(local), { contextId: target.contextId })
  if (!point?.ok) throw new Error(point?.error ?? `ref ${ref} could not be resolved`)
  let { x, y } = point
  if (frame > 0) {
    const offset = await frameOffset(cdp, pageSessionId, target.frame.id)
    x += offset.x
    y += offset.y
  }
  return { local, sessionId: target.sessionId, contextId: target.contextId, x, y }
}

export async function click(cdp, pageSessionId, pageTargetId, ref) {
  const { x, y } = await resolveTarget(cdp, pageSessionId, pageTargetId, ref)
  await moveCursor(cdp, pageSessionId, { x, y })
  await sleep(90)
  await cdp.send(
    'Input.dispatchMouseEvent',
    { type: 'mousePressed', x, y, button: 'left', clickCount: 1 },
    { sessionId: pageSessionId }
  )
  await sleep(70)
  await cdp.send(
    'Input.dispatchMouseEvent',
    { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 },
    { sessionId: pageSessionId }
  )
  return { x, y }
}

export async function fill(cdp, pageSessionId, pageTargetId, ref, text) {
  const target = await resolveTarget(cdp, pageSessionId, pageTargetId, ref)
  await moveCursor(cdp, pageSessionId, { x: target.x, y: target.y })
  const result = await evaluate(cdp, target.sessionId, fillScript(target.local, text), {
    contextId: target.contextId
  })
  if (!result?.ok) throw new Error(result?.error ?? `ref ${ref} could not be filled`)
  return result.value
}

export async function typeText(cdp, sessionId, text) {
  await cdp.send('Input.insertText', { text }, { sessionId })
}

export async function pressKey(cdp, sessionId, combo) {
  const { key, code, keyCode, modifiers, text } = parseKeyCombo(combo)
  const base = { key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, modifiers }
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', ...base, text }, { sessionId })
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base }, { sessionId })
}

export async function scroll(cdp, sessionId, deltaY) {
  const viewport = await evaluate(cdp, sessionId, '({ x: innerWidth / 2, y: innerHeight / 2 })')
  await moveCursor(cdp, sessionId, viewport, { steps: 6, durationMs: 150 })
  await cdp.send(
    'Input.dispatchMouseEvent',
    { type: 'mouseWheel', x: viewport.x, y: viewport.y, deltaX: 0, deltaY },
    { sessionId }
  )
}

export async function readPage(cdp, sessionId, what = 'text') {
  const expressions = {
    url: 'location.href',
    title: 'document.title',
    text: 'document.body ? document.body.innerText : ""',
    html: 'document.documentElement.outerHTML'
  }
  if (!expressions[what]) throw new Error(`unknown --what value "${what}" (use url, title, text or html)`)
  return evaluate(cdp, sessionId, expressions[what], { timeoutMs: 30_000 })
}

export async function evalInPage(cdp, sessionId, expression) {
  return evaluate(cdp, sessionId, expression, { awaitPromise: true, timeoutMs: 60_000 })
}

export async function screenshot(cdp, sessionId) {
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' }, { sessionId })
  return Buffer.from(data, 'base64')
}

/** Stable short id for logging a page without leaking its URL. */
export function pageFingerprint(url) {
  return createHash('sha1').update(String(url)).digest('hex').slice(0, 8)
}
