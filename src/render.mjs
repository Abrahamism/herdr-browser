/**
 * Text rendering for agent-facing output. Kept pure so it can be tested without a browser.
 */

export function renderTabs(tabs, { activeId, current } = {}) {
  if (!tabs.length) return 'no tabs'
  return tabs
    .map((tab) => {
      const isActive = tab.active === undefined ? tab.id === activeId : tab.active
      const marker = isActive ? '*' : ' '
      const owner = tab.session ?? null
      const session = owner === null ? 'unowned' : owner === current ? `${owner} (mine)` : owner
      return `${marker} [${tab.index}] ${tab.title}\n     ${tab.url}\n     ${tab.id}\n     session: ${session}`
    })
    .join('\n')
}

export function renderSnapshot(snapshot) {
  const lines = [`url: ${snapshot.url}`, `title: ${snapshot.title}`]
  if (!snapshot.items.length) {
    lines.push('(no interactive elements found)')
    return lines.join('\n')
  }
  let currentFrame = 0
  for (const item of snapshot.items) {
    const frame = item.frame ?? 0
    if (frame !== currentFrame) {
      currentFrame = frame
      const info = snapshot.frames?.find((entry) => entry.index === frame)
      lines.push(`--- frame ${frame}: ${info?.url ?? ''}`)
    }
    const bits = [`[${item.ref}]`, item.role]
    if (item.name) bits.push(JSON.stringify(item.name))
    if (item.type) bits.push(`type=${item.type}`)
    if (item.value !== undefined && item.value !== '') bits.push(`value=${JSON.stringify(item.value)}`)
    if (item.checked !== undefined) bits.push(`checked=${item.checked}`)
    if (item.disabled) bits.push('disabled')
    if (item.url) bits.push(`-> ${item.url}`)
    lines.push(bits.join(' '))
  }
  return lines.join('\n')
}

export function renderExtensions(extensions) {
  if (!extensions.length) return 'no extensions registered'
  return extensions
    .map((extension) => `${extension.name ?? '?'} ${extension.version ?? ''} ${extension.path}`.trim())
    .join('\n')
}

export function renderStatus({ state, version, tabs, sessions, session }) {
  if (!state) return 'browser: not running'
  const lines = [
    `browser: ${state.browser}`,
    `exe: ${state.exe}`,
    `port: ${state.port}`,
    `pid: ${state.pid ?? '?'}`,
    `profile: ${state.userData}`
  ]
  if (version) {
    lines.push(`version: ${version.Browser ?? version['User-Agent'] ?? 'unknown'}`)
    lines.push(`protocol: ${version['Protocol-Version'] ?? 'unknown'}`)
  }
  if (session) lines.push(`session: ${session}`)
  if (sessions?.length) {
    lines.push(`sessions: ${sessions.map((entry) => `${entry.session} (${entry.tabs.length})`).join(', ')}`)
  }
  if (tabs) lines.push(`tabs: ${tabs.length}`)
  return lines.join('\n')
}
