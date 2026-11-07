# Changelog

All notable changes to herdr-browser. This project uses semantic versioning.

## 1.2.0 (2026-11-06)

Closes the gap with browser tools built on an extension + relay, without adopting their
architecture: a dedicated profile, direct CDP, no dependencies.

### Added

- **`wait --for selector|text|url=<value> [--timeout]`** — blocks on a page condition
  instead of polling snapshots. A selector counts only when the element is rendered, and a
  timeout exits 1.
- **`handoff [--message] [--for] [--timeout]`** — prints the human step and blocks until the
  page navigates or the condition holds. This is how logins, 2FA and CAPTCHAs are resolved
  in the dedicated profile: the same process waits, there is no card and no daemon.
- **Bot challenge detection** — after a navigation, `open` recognizes Cloudflare, Akamai,
  DataDome, PerimeterX, Imperva, AWS WAF interstitials and mounted CAPTCHA widgets, waits
  `--challenge-wait` (15s, `HERDR_BROWSER_CHALLENGE_WAIT_MS`) for the browser to clear them
  and never solves an interactive one. Hard interstitials need two signals (title and text)
  so a page that merely mentions Cloudflare is not treated as a block.
- **`allow list|add|remove|clear` and `open --allow-origin`** — a per-session origin
  allowlist. `example.com` pins that host, `*.example.com` covers subdomains and never the
  apex, a URL pattern pins the scheme, `about:blank` is always reachable. A navigation
  outside the list is refused before it reaches the browser, and a redirect that leaves the
  list is blanked and refused.
- **`network [--url] [--idle] [--timeout] [--file] [--json]`** — captures a page's traffic
  into a HAR 1.2 with credential headers redacted and no response bodies. One invocation:
  attach, optionally navigate, wait for network idle, write the file.
- **`tabs cleanup [--idle] [--all] [--dry-run]`** — sweeps idle tabs. Tabs carry
  `lastUsedAt`, any command that resolves a tab resets it, and a tab nobody owns is never
  closed because it belongs to the human.

### Changed

- Refs are positions in one shared element scan instead of `data-herdr-browser-ref`
  attributes: nothing is written into the page, refs still work across processes, and if the
  DOM moves between `snapshot` and `click` the ref can address another element — re-run
  `snapshot` before acting.
- `--key=value` splits on the first `=` only, so `--for url=https://x?a=b` keeps its value.
- `--timeout`, `--idle` and `--challenge-wait` accept `500`, `30s`, `5m`.

### Fixed

- No `Runtime.enable` is sent to page sessions, the classic CDP automation tell. Frame
  contexts come from `Page.createIsolatedWorld` instead.
- The cursor lives in a closed shadow root and exposes no `window` globals.
- `--disable-blink-features=AutomationControlled` is passed at launch, so
  `navigator.webdriver` is false without patching descriptors.
- `--version` printed the help text instead of the version.
- `tabs cleanup` pruned the session file before closing, so a failed close left an orphan
  no sweep would ever reach. It now closes first and forgets after.
- `network --url` navigated without consulting the allowlist.

## 1.0.6

Tab TTL: `lastUsedAt`, `touchTab`, `idleTabs` and `tabs cleanup`.

## 1.0.5

Network capture into a redacted HAR (`network`).

## 1.0.4

Per-session origin allowlist (`allow`, `open --allow-origin`).

## 1.0.3

Stealth: no `Runtime.enable`, refs by scan position, closed-shadow cursor and the
automation-control launch switch.

## 1.0.2

Bot challenge detection and `--challenge-wait`.

## 1.0.1

`wait` and `handoff`; `--version` reports the package version.
