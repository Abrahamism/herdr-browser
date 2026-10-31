#!/usr/bin/env node
import { spawn } from 'node:child_process'
import path from 'node:path'

const root = process.env.HERDR_PLUGIN_ROOT || process.cwd()
const cli = path.join(root, 'bin', 'herdr-browser.mjs')

function runCli(args) {
  return new Promise((resolve) => {
    const child = spawn('node', [cli, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', (error) => {
      stderr += error.message
      resolve({ code: 1, stdout, stderr })
    })
    child.on('close', (code) => {
      resolve({ code: code ?? 0, stdout, stderr })
    })
  })
}

function truncate(text, width) {
  if (width <= 0) return ''
  if (text.length <= width) return text
  return text.slice(0, Math.max(0, width - 1)) + '…'
}

async function main() {
  if (!process.stdin.isTTY) {
    const result = await runCli(['tabs'])
    if (result.stdout) process.stdout.write(result.stdout)
    if (result.stderr) process.stderr.write(result.stderr)
    process.exitCode = 0
    return
  }

  process.stdout.write('\x1b[?1049h')
  process.stdout.write('\x1b[?25l')
  process.stdin.setRawMode(true)
  process.stdin.resume()

  let tabs = []
  let selected = 0
  let errorLine = null
  let busy = false
  let running = true

  const cleanup = () => {
    try { process.stdin.setRawMode(false) } catch {}
    process.stdout.write('\x1b[?25h')
    process.stdout.write('\x1b[?1049l')
  }

  const fetchTabs = async () => {
    const result = await runCli(['tabs', '--json'])
    if (result.code === 0) {
      try {
        tabs = JSON.parse(result.stdout)
        errorLine = null
      } catch {
        tabs = []
        errorLine = result.stdout.trim().split(/\r?\n/)[0] || 'error al leer pestañas'
      }
    } else {
      tabs = []
      errorLine = (result.stderr || result.stdout).trim().split(/\r?\n/)[0] || 'error'
    }
    if (selected >= tabs.length) selected = Math.max(0, tabs.length - 1)
    render()
  }

  const render = () => {
    const cols = process.stdout.columns || 80
    let out = '\x1b[H\x1b[2J'
    if (errorLine) {
      out += `${errorLine}\n`
      out += 'navegador no está corriendo — presiona o para lanzar, q para salir\n'
    } else if (!tabs.length) {
      out += 'sin pestañas\n'
    } else {
      for (let i = 0; i < tabs.length; i += 1) {
        const tab = tabs[i]
        const marker = i === selected ? '>' : ' '
        const title = truncate(String(tab.title ?? ''), Math.max(1, cols - 4))
        out += `${marker} ${i} ${title}\n`
        out += `${truncate('   ' + String(tab.url ?? ''), cols)}\n`
      }
    }
    out += '\nj/k mover  Enter activar  x cerrar  r refrescar  o abrir  q salir\n'
    process.stdout.write(out)
  }

  let quitResolve
  const quitPromise = new Promise((resolve) => { quitResolve = resolve })

  const onKey = async (buffer) => {
    if (busy || !running) return
    const key = buffer.toString('utf8')
    if (key === 'q') {
      running = false
      quitResolve()
      return
    }
    if (key === 'j' || key === '\x1b[B') {
      if (selected < tabs.length - 1) selected += 1
      render()
      return
    }
    if (key === 'k' || key === '\x1b[A') {
      if (selected > 0) selected -= 1
      render()
      return
    }
    if (key === '\r' || key === '\n') {
      const tab = tabs[selected]
      if (tab) {
        busy = true
        await runCli(['activate', tab.id])
        await fetchTabs()
        busy = false
      }
      return
    }
    if (key === 'x') {
      const tab = tabs[selected]
      if (tab) {
        busy = true
        await runCli(['close', tab.id])
        await fetchTabs()
        busy = false
      }
      return
    }
    if (key === 'r') {
      busy = true
      await fetchTabs()
      busy = false
      return
    }
    if (key === 'o') {
      busy = true
      await runCli(['open'])
      await fetchTabs()
      busy = false
      return
    }
  }

  process.stdin.on('data', (buffer) => { void onKey(buffer) })
  process.stdout.on('resize', () => { render() })

  const onSignal = () => {
    running = false
    quitResolve()
  }
  process.on('SIGINT', onSignal)
  process.on('SIGTERM', onSignal)

  const interval = setInterval(() => {
    if (!busy && running) void fetchTabs()
  }, 1000)

  try {
    await fetchTabs()
    await quitPromise
  } finally {
    clearInterval(interval)
    process.removeListener('SIGINT', onSignal)
    process.removeListener('SIGTERM', onSignal)
    cleanup()
  }
}

main().catch(() => {
  try { process.stdin.setRawMode(false) } catch {}
  process.stdout.write('\x1b[?25h')
  process.stdout.write('\x1b[?1049l')
  process.exitCode = 1
})
