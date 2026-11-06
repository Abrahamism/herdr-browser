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
   - Refs (`e1`, `e2`…) belong to the page as it is right now.
3. **Choose by role and name**, never by guessing. If the target is not in the snapshot,
   the page changed: run `snapshot` again.
4. **Act, one step at a time**
   - `click e3`
   - `fill e4 "texto"` (focuses and sets the value)
   - `type "texto"` (types into whatever has focus)
   - `key Enter`, `key Tab`, `key Control+A`
   - `scroll down 800`
5. **Verify after every action that changes the page**
   - `get --what url`, `get --what title`, or a new `snapshot`.
   - A click that opened a menu or a navigation invalidates the old refs.
6. **Capture evidence when the user wants to see it**: `shot <file.png>`.

## Sessions (more than one agent)

Every command belongs to a session: `--session <name>` or `HERDR_BROWSER_SESSION`,
`default` otherwise. Your session owns the tabs it opened, and a command without
`--page` only ever resolves your own tabs.

- Pass a session name whenever another agent or the user shares the same profile:
  `--session agent-a`. Without one you are `default` and behave exactly like a single client.
- `open` reuses your session's tab and allocates one when you have none. `--new` forces a
  new tab; `--reuse` reuses yours or adopts a tab nobody owns.
- If your session has no tab, the command fails with an error that names the session and the
  fix: it says `owns no tabs` and to run `open <url>`, and when every open tab belongs
  to someone else it adds how to address one with `--page <id>`. Never assume it fell
  back to the first tab.
- `tabs --json` reports `session`, `owned` and `active` for every tab, so you can see which
  one is yours without guessing.
- `stop` closes only your session's tabs, and the browser only when no tab is left.
  `stop --all` closes the shared browser: use it when the user asks for it.

## Rules

- **Never invent refs.** Only click or fill refs returned by the latest `snapshot`.
- **Re-snapshot after navigation, tab changes, or dialogs.**
- **Do not disable the cursor**; the visible pointer is the point.
- **Credentials:** if the page asks for a login, stop and ask the user to sign in in
  that window. Never read, type or ask for a password in chat.
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
- `stop` closes your session's tabs; `stop --all` closes the shared browser. Do not run
  either unless the user asks.
