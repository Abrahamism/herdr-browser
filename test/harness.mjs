import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeServer } from './fake-cdp.mjs'

/**
 * Boot the fake DevTools endpoint with a ready profile, run the body, clean up.
 * Every CLI test needs the same three files; keeping them in one place is the point.
 */
export async function withFakeCdp(fn, { targets } = {}) {
  const { server, state } = makeServer(targets ? { targets } : undefined)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const tmp = join(tmpdir(), `hb-fake-${Date.now()}-${Math.random().toString(16).slice(2)}`)
  const home = join(tmp, 'home')
  const profileDir = join(home, 'profiles', 'default')
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(
    join(profileDir, 'state.json'),
    JSON.stringify({ port, browser: 'brave', exe: 'fake', userData: join(profileDir, 'user-data') })
  )
  try {
    return await fn({ home, state, port })
  } finally {
    await new Promise((resolve) => setTimeout(resolve, 300))
    try {
      server.close()
    } catch {}
    rmSync(tmp, { recursive: true, force: true })
  }
}
