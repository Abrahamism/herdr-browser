/**
 * Page targets (tabs) and the active-tab bookkeeping shared by the CLI and the panel.
 */

const IGNORED_URL_PREFIXES = ['devtools://', 'chrome-extension://', 'brave://', 'chrome://']

export function isPageTarget(target) {
  return target.type === 'page' && !IGNORED_URL_PREFIXES.some((prefix) => (target.url ?? '').startsWith(prefix))
}

export async function listTabs(cdp) {
  const { targetInfos } = await cdp.send('Target.getTargets')
  return targetInfos.filter(isPageTarget).map((target, index) => ({
    index,
    id: target.targetId,
    title: target.title || '(sin título)',
    url: target.url,
    attached: Boolean(target.attached)
  }))
}

export async function listAllTargets(cdp) {
  const { targetInfos } = await cdp.send('Target.getTargets')
  return targetInfos
}

export function resolveTab(tabs, selector) {
  if (!selector) {
    const byActive = tabs.find((tab) => tab.active) ?? tabs[0]
    if (!byActive) throw new Error('no page tabs are open; run `herdr-browser open <url>` first')
    return byActive
  }
  const needle = String(selector)
  if (/^\d+$/.test(needle)) {
    const byIndex = tabs[Number.parseInt(needle, 10)]
    if (byIndex) return byIndex
  }
  const matches = tabs.filter((tab) => tab.id === needle || tab.id.startsWith(needle))
  if (matches.length === 1) return matches[0]
  if (matches.length > 1) throw new Error(`tab "${needle}" is ambiguous (${matches.length} matches)`)
  throw new Error(`tab "${needle}" not found; run \`herdr-browser tabs\` to list them`)
}

export async function openTab(cdp, url) {
  const { targetId } = await cdp.send('Target.createTarget', { url: url || 'about:blank' })
  return targetId
}

export async function activateTab(cdp, targetId) {
  await cdp.send('Target.activateTarget', { targetId })
}

export async function closeTab(cdp, targetId) {
  await cdp.send('Target.closeTarget', { targetId })
}
