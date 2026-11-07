---
name: herdr-browser
description: Drive a real Chromium browser (Brave by default) with a visible cursor and Chrome extensions. Use when the user asks to open a URL, look at a page, click, fill a form, take a screenshot, or inspect what a web app does.
---

# herdr-browser

A real browser in its own window, controlled through CDP. The pointer moves and clicks
visibly inside the page, so the user can watch the process. It is not headless unless
you pass `--headless`.

Run every command from the repository root (or use the absolute path to the clone):

```bash
cd /path/to/herdr-browser
node bin/herdr-browser.mjs <command>
```

## The loop

1. **Open or find the tab**
   - `open <url>` — launches the browser if needed and navigates the tab your session owns
     (it allocates one the first time).
   - `tabs` — list open tabs when you are not sure what is loaded.
2. **Read the page before acting**: `snapshot`
   - Returns `url`, `title` and one line per interactive element: `[e3] button "Sign in"`.
   - A ref is a **position** in the snapshot's scan, not an attribute in the page: `e3` is
     "the third matching element, visible, in DOM order". It survives across commands,
     but if the DOM changes the number can point at another element.
3. **Choose by role and name**, never by guessing. If the target is not in the snapshot,
   the page changed: run `snapshot` again — and do that **before** any click or fill after
   a navigation, a menu, or a dialog.
4. **Act, one step at a time**
   - `click e3`
   - `fill e4 "texto"` (focuses and sets the value)
   - `type "texto"` (types into whatever has focus)
   - `key Enter`, `key Tab`, `key Control+A`
   - `scroll down 800`
5. **Verify after every action that changes the page**
   - `get --what url`, `get --what title`, or a new `snapshot`.
6. **Capture evidence when the user wants to see it**: `shot <file.png>`.

## Waiting instead of guessing

Do not poll `snapshot` in a loop. Ask the page:

```bash
node bin/herdr-browser.mjs wait --for selector=#tablero --timeout 20s
node bin/herdr-browser.mjs wait --for text="Sesión iniciada"
node bin/herdr-browser.mjs wait --for url=/home --timeout 1m --json
```

A `selector=` counts only when the element is **rendered**. When the budget runs out the
command exits **1** and prints what it actually saw: a timeout is never success.

## Handing the browser to the person

A login, a 2FA code or a CAPTCHA is not yours to solve. Hand the window over and block:

```bash
node bin/herdr-browser.mjs handoff --message "Entra con tu SSO y avísame" --timeout 5m
node bin/herdr-browser.mjs handoff --for selector=#inicio --timeout 5m
```

It prints the message for the user and continues when the page navigates (or when the
`--for` condition holds). Tell the user what you are waiting for before running it.

Some sites still refuse: the challenge loops even after the person solves the visual step,
because the page is being driven through CDP. That is not a `handoff` problem, it is a launch
problem. Use a profile whose session was established without the debugger:

```bash
node bin/herdr-browser.mjs login https://dash.cloudflare.com --profile cf
node bin/herdr-browser.mjs --profile cf open https://dash.cloudflare.com
```

`login` opens the browser with no debugging port and waits for the person to close the window.
After that, every command on that profile starts authenticated. A brand-new profile has no
extensions and no cookies: if the person needs their password manager there, run
`profile import --from brave` (with their browser closed) or `extensions add <dir>` for an
unpacked extension.

## Bot challenges

After a navigation, `open` reports Cloudflare, Akamai, DataDome, PerimeterX, Imperva, AWS
WAF and CAPTCHA interstitials:

```
challenge: cloudflare (title and text) — still there after 15s; run `herdr-browser handoff`
```

It waits up to `--challenge-wait` (15s by default) for checks the browser clears by itself
and **never** solves an interactive one. If you see a `challenge:` line, do not describe the
page as if it were the real content: say the site is blocking and hand off to the user.

## Staying inside the allowed sites

When the user wants the agent pinned to specific sites:

```bash
node bin/herdr-browser.mjs open https://app.example.com --allow-origin app.example.com
node bin/herdr-browser.mjs allow list
node bin/herdr-browser.mjs allow add "*.example.com"
```

`example.com` matches only that host; `*.example.com` matches subdomains and not the apex.
A navigation outside the list is refused with `blocked: <url>` and exit 1 — that includes a
redirect and `network --url`. If you get `blocked`, stop and ask: do not try another route
to the same site.

## Inspecting traffic

To answer "which API did this page call?":

```bash
node bin/herdr-browser.mjs network --url https://app.example.com/home --file capture.har --json
```

One invocation: attach, optionally navigate, wait for network idle, write a HAR 1.2 with
credential headers and credential query parameters redacted and no response bodies.
Response bodies and cookies are not stored.

## Sessions (more than one agent)

Every command belongs to a session: `--session <name>` or `HERDR_BROWSER_SESSION`,
`default` otherwise. Your session owns the tabs it opened, and a command without
`--page` only ever resolves your own tabs.

- Pass a session name whenever another agent or the user shares the same profile:
  `--session agent-a`.
- `open` reuses your session's tab and allocates one when you have none. `--new` forces a
  new tab; `--reuse` reuses yours or adopts a tab nobody owns.
- If your session has no tab, the command fails with an error that names the session and
  the fix. Never assume it fell back to the first tab.
- `tabs --json` reports `session`, `owned` and `active` for every tab.
- `stop` closes only your session's tabs, and the browser only when no tab is left.
  `tabs cleanup --idle 10m` closes your own idle tabs; `--all` reaches every session.
  A tab nobody owns belongs to the human and is never closed.
- `stop --all` closes the shared browser: use it when the user asks for it.

## Rules

- **Never invent refs.** Only click or fill refs returned by the latest `snapshot`.
- **Re-snapshot after navigation, tab changes, or dialogs.** A stale ref can address a
  different element.
- **Do not disable the cursor**; the visible pointer is the point.
- **Credentials:** if the page asks for a login, use `handoff` and let the user sign in.
  Never read, type or ask for a password in chat.
- **Read-only by default.** Submit forms, publish or delete only if the user asked.
- **Refs with a frame prefix** (`f1e12`) belong to content inside an iframe, including
  out-of-process iframes. Use the ref as-is for `click` and `fill`.
- **`eval` and `get` only see the top document.** If the content lives in an iframe, use
  `snapshot` + `click`/`fill`, not `eval`.
- When you finish, report the final URL, the title, and any screenshot path.

## Useful extras

- `extensions add <dir>` registers an unpacked extension and loads it if the browser is running.
- `profile import` copies cookies and extensions from the user's Brave profile; the source
  browser must be closed. Only run it when the user asks.
- `--challenge-wait 0` reports a challenge without waiting.
- `--json` on `open`, `tabs`, `status`, `wait`, `handoff`, `network` and `tabs cleanup`
  gives machine-readable output.
