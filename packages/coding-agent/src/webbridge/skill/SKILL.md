---
name: loom-webbridge
description: Loom's own bridge to the user's REAL local browser (their actual login sessions) via a loopback HTTP daemon on port 10088 plus a Chrome/Edge/Brave extension. Use this skill for ANY real-browser task — navigate, click, type, read, screenshot, scrape behind a login, or interact with a site using the user's own session. Also use when the user mentions "browser", "webpage", "open URL", "screenshot", or asks to read/interact with a site. This is the authoritative browser skill for loom; prefer it over the built-in headless browser tool when real login state matters, and over any other webbridge-style skill.
---

# Loom WebBridge

Drive the user's real browser from loom. A local daemon exposes a loopback HTTP
endpoint on **port 10088**; a companion MV3 browser extension executes each
command against the live browser using `chrome.*` APIs (tabs / scripting /
debugger). Because it is the user's actual browser, their existing logins,
cookies, and sessions apply.

> **This is loom's bridge — always use port 10088.** If a separate
> `kimi-webbridge` (or any other browser) skill is also installed, ignore it:
> it targets a different daemon (Kimi uses port 10086) and is unrelated to
> loom. Every request below MUST go to `http://127.0.0.1:10088`.

## One-time setup

1. `loom webbridge install` — **permanently force-installs** the extension into
   every detected Chromium-family browser (chrome/chromium/edge/brave) via each
   browser's enterprise policy store. No Developer mode, survives restarts. On
   Linux the policy is machine-wide — the command elevates with `sudo`
   automatically, prompting for your password when needed. **Fully quit and
   reopen the browser** so the policy loads.
   - `--dev` instead writes the unpacked extension to `~/.omp/webbridge/extension`
     and prints manual **Load unpacked** steps (Developer mode).
   - `--system` forces the machine-wide store on Windows/macOS too (needs elevation).
   - `loom webbridge uninstall` removes the force-install policy.
2. `loom webbridge start` — launches the daemon in the background and opens (or
   focuses) your browser so the extension connects (port 10088; override with
   `LOOM_WEBBRIDGE_PORT` or `--port`; `--no-open` skips opening the browser).
3. `loom webbridge status` — confirm `browser extension: connected`.

## Managing the bridge from inside a loom session

The `/webbridge` slash command shares one control plane with the
`loom webbridge` CLI, so you can manage the daemon and extension without
leaving the session:

- `/webbridge status` — daemon + extension health (default when no subcommand
  is given).
- `/webbridge start` — start the daemon and open/focus the browser.
- `/webbridge stop` — stop the background daemon.
- `/webbridge install` — force-install the extension into every detected
  Chromium-family browser. It tries passwordless `sudo -n`; if a password is
  needed it prompts inline (interactive sudo).
- `/webbridge uninstall` — remove the force-install policy.

## Wire protocol

POST JSON to `http://127.0.0.1:10088/command`:

```
{ "action": "<action>", "args": { ... }, "session": "<optional session id>" }
```

Response is `{ "ok": true, "data": {...} }` or
`{ "ok": false, "error": { "code": "...", "message": "..." } }`.

`session` puts every tab it touches into its own Chrome **tab group** named
`loom:<session>`, isolated from other sessions (own current tab, own colour).
Many loom sessions can therefore drive the **same browser at once**, each in a
separate tab group, without stepping on each other. Single-tab actions target
that session's current tab — `navigate` first.

**You normally never set `session` yourself.** `loom webbridge call` fills it in
automatically — on the box each workstream is its own tmux session, so its tabs
land in a `loom:<tmux-session>` group with zero effort. Override only to split
or share a group deliberately: pass `--session <id>` (CLI) or set
`$LOOM_WEBBRIDGE_SESSION`. If you POST with `curl` directly, add
`"session":"<id>"` yourself — raw curl has no way to infer the workstream.

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
| `focus` | — | `{focused, windowId}` — raise the browser window |
| `cdp` | `method`, `params?` | `{result}` — raw Chrome DevTools Protocol escape hatch |

**Selectors:** a CSS selector, or `@eN` to target the element with snapshot
`ref` `eN` (snapshot stamps `data-loom-ref` so refs stay valid across calls).

## Usage from the shell

The daemon is plain HTTP — use `curl` against **port 10088**, or the
convenience verb:

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
  banner — expected.
- Runs on port 10088 (Kimi's bridge, if present, is a different daemon on
  10086 — do not use it).
- If a command returns `extension_not_connected`, the extension is not loaded or
  the daemon is down — check `loom webbridge status` (or `/webbridge status`
  inside a session).
