---
name: loom-webbridge
description: Loom WebBridge lets loom drive the user's real local browser (their actual login sessions) via a loopback HTTP daemon plus a Chrome/Edge extension. Use this skill whenever the user wants to interact with websites, automate browser tasks, scrape content behind a login, take screenshots, or perform any action needing a real logged-in browser. Also use when the user mentions "browser", "webpage", "open URL", "screenshot", or asks to read/interact with a site using their own session. Prefer this over the built-in headless browser tool when real login state is required.
---

# Loom WebBridge

Drive the user's real browser from loom. A local daemon exposes a loopback HTTP
endpoint; a companion MV3 browser extension executes each command against the
live browser using `chrome.*` APIs (tabs / scripting / debugger). Because it is
the user's actual browser, their existing logins, cookies, and sessions apply.

## One-time setup

1. `loom webbridge install` — **permanently force-installs** the extension into
   every detected Chromium-family browser (chrome/chromium/edge/brave) via each
   browser's enterprise policy store. No Developer mode, survives restarts. On
   Linux the policy is machine-wide (the command uses `sudo -n`; if that is not
   available it prints the exact `sudo` commands to paste). **Fully quit and
   reopen the browser** so the policy loads.
   - `--dev` instead writes the unpacked extension to `~/.omp/webbridge/extension`
     and prints manual **Load unpacked** steps (Developer mode).
   - `--system` forces the machine-wide store on Windows/macOS too (needs elevation).
   - `loom webbridge uninstall` removes the force-install policy.
2. `loom webbridge start` — launches the daemon in the background (port 10088;
   override with `LOOM_WEBBRIDGE_PORT` or `--port`).
3. `loom webbridge status` — confirm `browser extension: connected`.

## Wire protocol

POST JSON to `http://127.0.0.1:10088/command`:

```
{ "action": "<action>", "args": { ... }, "session": "<optional session id>" }
```

Response is `{ "ok": true, "data": {...} }` or
`{ "ok": false, "error": { "code": "...", "message": "..." } }`.

`session` groups tabs into an isolated workspace (defaults to `"default"`).
Single-tab actions target the session's current tab — `navigate` first.

## Actions

| action | args | returns |
|---|---|---|
| `navigate` | `url`, `newTab?` | `{success, url, tabId}` |
| `snapshot` | — | `{url, title, tree}` — accessibility tree; interactive nodes carry a `ref` like `e12` |
| `click` | `selector` | `{success, tag, text}` |
| `fill` | `selector`, `value` | `{success, tag}` |
| `evaluate` | `code` | `{type, value}` — runs in the page (CDP main world) |
| `screenshot` | `format?` (`png`/`jpeg`), `path?` | `{format, path, sizeBytes, mimeType}` — bytes written to disk; `read` the path |
| `list_tabs` | — | `{tabs:[{id,url,title,active}]}` |
| `find_tab` | `query`, `activate?` | `{matched, tabs}` — sets current tab to first match |
| `close_tab` | `tabId?` | `{success}` |
| `close_session` | — | `{success}` — closes every tab in the session |
| `cdp` | `method`, `params?` | `{result}` — raw Chrome DevTools Protocol escape hatch |

**Selectors:** a CSS selector, or `@eN` to target the element with snapshot
`ref` `eN` (snapshot stamps `data-loom-ref` so refs stay valid across calls).

## Usage from the shell

The daemon is plain HTTP — use `curl`, or the convenience verb:

```
loom webbridge call navigate --args '{"url":"github.com/notifications"}'
loom webbridge call snapshot
loom webbridge call click --args '{"selector":"@e12"}'
loom webbridge call screenshot
```

Recommended loop: `navigate` → `snapshot` to discover `@eN` refs →
`click`/`fill` by ref → re-`snapshot` after the page changes (refs are
re-minted per snapshot). Use `evaluate` for reads the tree misses and `cdp` for
anything unsupported.

## Notes

- `evaluate`/`cdp` attach the Chrome debugger to the tab, which shows a browser
  banner — expected, same as Kimi WebBridge.
- Runs on a different port (10088) than Kimi (10086), so both can coexist.
- If a command returns `extension_not_connected`, the extension is not loaded or
  the daemon is down — check `loom webbridge status`.
