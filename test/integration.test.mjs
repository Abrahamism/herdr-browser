import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveBrowser } from '../src/browsers.mjs'

const CLI = join(process.cwd(), 'bin', 'herdr-browser.mjs')

function runCli(home, args) {
  return new Promise((resolve) => {
    const child = spawn('node', [CLI, ...args], {
      env: { ...process.env, HERDR_BROWSER_HOME: home },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (c) => { stdout += c })
    child.stderr.on('data', (c) => { stderr += c })
    child.on('close', (code) => resolve({ status: code ?? 0, stdout, stderr }))
  })
}

test('e2e brave headless', { skip: !(process.env.HB_E2E === '1' || process.env.npm_lifecycle_event === 'test:e2e') }, async (t) => {
  let browser
  try {
    browser = resolveBrowser('brave', {})
  } catch (e) {
    t.skip('Brave not found')
    return
  }

  const home = mkdtempSync(join(tmpdir(), 'hb-e2e-'))
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html')
    res.end('<!doctype html><html><body><button id="b" onclick="document.title=\'clicked\'">Click me</button><input id="i" /></body></html>')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${server.address().port}/`

  try {
    const rOpen = await runCli(home, ['open', url, '--headless'])
    assert.equal(rOpen.status, 0, rOpen.stderr + rOpen.stdout)

    const rTabs = await runCli(home, ['tabs', '--json'])
    assert.equal(rTabs.status, 0, rTabs.stderr)
    const tabs = JSON.parse(rTabs.stdout)
    assert.ok(tabs.length >= 1)

    const rSnap = await runCli(home, ['snapshot', '--json'])
    assert.equal(rSnap.status, 0, rSnap.stderr)
    const snap = JSON.parse(rSnap.stdout)
    const button = snap.items.find((i) => i.role === 'button')
    const input = snap.items.find((i) => i.role === 'input' || i.role === 'textbox')
    assert.ok(button, 'button not found')
    assert.ok(input, 'input not found')

    const rFill = await runCli(home, ['fill', input.ref, 'hello'])
    assert.equal(rFill.status, 0, rFill.stderr)

    const rEval = await runCli(home, ['eval', 'document.querySelector("#i").value'])
    assert.equal(rEval.status, 0, rEval.stderr)
    assert.match(rEval.stdout, /hello/)

    const rClick = await runCli(home, ['click', button.ref])
    assert.equal(rClick.status, 0, rClick.stderr)

    const rTitle = await runCli(home, ['get', '--what', 'title'])
    assert.equal(rTitle.status, 0, rTitle.stderr)
    assert.match(rTitle.stdout, /clicked/)

    const shotPath = join(tmpdir(), `hb-shot-${Date.now()}.png`)
    const rShot = await runCli(home, ['shot', shotPath])
    assert.equal(rShot.status, 0, rShot.stderr)
    assert.ok(existsSync(shotPath))

    const rStop = await runCli(home, ['stop'])
    assert.equal(rStop.status, 0, rStop.stderr)
  } finally {
    await runCli(home, ['stop'])
    server.close()
    // Brave can hold profile files for a moment after Browser.close on Windows.
    try {
      rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
    } catch {
      // A leftover temp profile is not a product failure; the OS cleans it up.
    }
  }
})
