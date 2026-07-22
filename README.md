# Loom

**Weave parallel AI agents, real-browser control, and multi-repo memory into one terminal harness.**

Loom is an AI coding agent for the terminal — a fork of [oh-my-pi](https://github.com/can1357/oh-my-pi), extended with capabilities no other terminal agent ships: it can drive *your real browser, with your real logins*, remember what it did across every repository it touches, and orchestrate parallel subagents in isolated git worktrees while keeping you in full control. One binary. One terminal. The whole weave.

## Highlights

- **Hash-anchored editing** — files display with content-hash line anchors; edits reference those anchors with mismatch detection and automatic recovery, plus four switchable edit strategies (`replace`, `patch`, `hashline`, `apply_patch`).
- **WebBridge: real-browser control** — drive your actual logged-in browser: navigate, click, fill, evaluate JS, screenshot, manage tabs — through a loopback daemon and a force-installed MV3 extension.
- **Parallel subagent orchestration** — spawn subagents in parallel batches or async background jobs, with structured output schemas, depth limits, and git-worktree isolation; coordinate live over an IRC-style inter-agent channel.
- **Web search across 13 providers** with automatic provider-chain fallback — Anthropic, Perplexity, Exa, Brave, Jina, Kimi, Gemini, Codex, Tavily, Kagi, Z.AI, SearXNG, and Synthetic.
- **Broad model & provider support** — Anthropic, OpenAI (Completions, Responses, Codex), Google (Gemini, Gemini CLI, Vertex), Amazon Bedrock, Azure OpenAI, GitHub Copilot, GitLab Duo, Kimi, Ollama, Cursor, Devin, and Synthetic, with dual API-key/OAuth auth and a durable credential store.
- **LSP + debugger code intelligence** — full language-server integration with diagnostics streamed back on every edit, plus a 28-action DAP debugger: breakpoints, stepping, evaluate, disassembly, memory read/write, multi-session.
- **Multi-repo context memory** — per-repo markdown status ledgers distilled from the session transcript, updated in parallel across every repo the agent touches.

## Features

### Editing

- **Hashline edit engine (default):** files display with content-hash line anchors; edits reference those anchors with mismatch detection and automatic recovery.
- **Four switchable edit strategies** — `replace`, `patch`, `hashline`, `apply_patch` — selectable globally or per-model.
- **Multi-file `apply_patch` mode** with its own streaming grammar.
- **AST-aware tooling:** structural search (`ast_grep`) and structural refactoring edits (`ast_edit`) across globs.
- **Live streaming diff previews** as edits stream in.
- **Jupyter notebook (`.ipynb`) editing.**
- **File snapshots + conflict detection** guard against stale or external changes.

### Tool suite

27 built-in tools behind tiered approval, surfaced through a discoverable `xd://` device model that keeps the always-on tool surface small.

- **`read`:** line-range selectors, `:raw`, multi-range reads; handles local files, zip/tar members, SQLite tables and queries, images, documents, internal URLs, and remote files over `ssh://`.
- **`bash`:** PTY-interactive execution, background/async jobs, command interception.
- **`grep` / `glob`:** ripgrep-backed regex and fast gitignore-aware globbing, both SSH-remote capable.
- **`github`:** repos, files, PRs, and Actions, with cached `issue://` / `pr://` reads.
- **`web_search` across 13 providers** (Anthropic, Perplexity, Exa, Brave, Jina, Kimi, Gemini, Codex, Tavily, Kagi, Z.AI, SearXNG, Synthetic) with automatic provider-chain fallback.
- Plus `ask`, `todo` (markdown round-trip), `eval`, `inspect_image`, `image_gen`, and `tts`.

### Code intelligence

- **Full LSP tool:** definition, type definition, implementation, references, hover, document/workspace symbols, diagnostics (single-file, batch, or workspace-wide), code actions (with apply), workspace-wide rename, format, file/directory rename with import rewrites, server status/reload, and raw requests.
- **LSP writethrough:** every edit and write streams to language servers and returns fresh diagnostics inline, with deferred late-diagnostics delivery.
- Multi-server config, custom linters, and Go/Rust workspace awareness.
- **DAP debugger with 28 actions:** launch/attach, source/instruction/data breakpoints, stepping, evaluate, stack traces, scopes/variables, disassembly, read/write memory, modules, and multi-session support.

### Orchestration & subagents

- **`task` tool:** spawn subagents from discovered agent definitions (bundled, project, and user) in parallel batches or as async background jobs, with depth limits, per-spawn structured output schemas, and git-worktree isolation.
- **`hub` tool:** message peer agents; supervise long-running named processes (start/stop/logs/stdin/signals); manage background jobs.
- **IRC-style inter-agent channel** for live coordination.
- **Plan mode** with a read-only guard, approved-plan enforcement, and model transition.
- **Live multi-user collab:** host/guest sessions over an encrypted relay.
- **MCP client support** — MCP tools exposed as `mcp__*`.
- **Extensibility API:** plugins register tools, rules, skills, hooks, slash commands, prompts, MCP servers, and SSH targets.

### Models & providers

- **Broad provider set:** Anthropic, OpenAI (Completions + Responses + Codex), Google (Gemini, Gemini CLI, Vertex), Amazon Bedrock (SigV4), Azure OpenAI, GitHub Copilot, GitLab Duo, Kimi, Ollama, Cursor, Devin, and Synthetic.
- **Dual auth:** API keys and OAuth with refresh; multi-credential per provider, credential ranking, health probing, and rate-limit handling, backed by a durable SQLite credential store.
- **Auth broker/gateway:** a shared remote credential service with import/migration.
- **Local model endpoints:** Loom serves OpenAI-compatible and Anthropic-compatible endpoints so other tools can reuse its auth and models.

### Memory & sessions

- **Resume, continue, and fork sessions** (`--resume`, `--continue`, `--fork`, `/resume`, `/fork`) with a session-tree navigator.
- **Pluggable session storage:** JSONL, indexed, SQLite, or Redis, with listing, migrations, and garbage collection with cold-archive.
- **Git-based checkpoints** and `rewind` to restore session + workspace state.
- **Context compaction** (automatic and manual `/compact`) with multiple strategies and a savings journal.
- **Long-term memory tools** (`retain`, `recall`, `reflect`, `learn`) over local Mnemopi and Hindsight backends.
- **Session export** to self-contained HTML, plus encrypted link/gist sharing.
- **Skills system** via `skill://` URLs; the agent can create and update managed skills.

### Terminal UX

- **Rich markdown rendering,** including mermaid diagrams rendered as ASCII and LaTeX math rendered to Unicode.
- **Inline images** via the Kitty graphics protocol; mouse support; tmux integration; desktop notifications.
- **Fullscreen interactive mode:** fuzzy autocomplete (slash commands, files, emojis, GitHub refs, internal URLs), keybindings, kill-ring, and a light/dark theme system.
- **Four run modes:** interactive TUI, print/headless, JSON-RPC host mode, and an ACP bridge for editors like Zed.
- **Setup wizard** plus startup environment detection (GPU/CPU) injected into the system prompt.

## What's new in Loom

Everything above is the foundation Loom inherits. Everything below exists **only in Loom**.

### WebBridge — control your real browser, with your real logins

Headless browsers start from zero: no cookies, no sessions, no you. WebBridge drives your **actual browser with its real login sessions** — navigate, take accessibility-tree snapshots, click, fill, evaluate JS, screenshot, and list/find/close tabs, with a raw CDP escape hatch for anything else.

- A thin **loopback HTTP + WebSocket daemon** forwards `{action, args, session}` commands to an MV3 browser extension and correlates the replies; screenshots land on disk as files the model can read.
- **Session-scoped tab groups:** each task's tabs are grouped together in your browser, so agent work never dissolves into your own.

### One-command permanent install

`loom webbridge install` packs a **self-signed CRX3** — dependency-free ZIP + protobuf + RSA signing, yielding a deterministic Chromium extension id — and **force-installs it into every detected browser via enterprise policy**. No Developer mode toggle, and it survives restarts.

- Cross-platform policy writer: Windows registry `ExtensionInstallForcelist`, macOS `defaults` forcelist, Linux managed-policy JSON. Idempotent, and it removes only its own entry.
- Detects **Chrome, Chromium, Edge, and Brave** across macOS, Linux (PATH plus snap/flatpak/NixOS), and Windows.

### Multi-repo context memory

Loom maintains **per-repo markdown status ledgers** distilled from the session transcript, triggered on compaction, shutdown, or idle. It detects which repos you touched from tool-call paths and runs **one focused ledger turn per repo in parallel** (capped at 8), with atomic writes and a non-blocking shutdown handoff. Come back to any repo and the context is already there.

### Context Activity

Fire-and-forget lifecycle events — start/done/skip/fail for syncs and compactions — give you **live observability of background work**, with a strict time ceiling so observability never blocks the agent.

### Compaction model routing fix

Models using reverse-engineered Claude Code OAuth framing are no longer chosen for local compaction summaries — they're deferred behind every other enabled model. An explicitly configured compaction model still stays primary.

### `/switch` inline autocomplete

`/switch [model]` offers inline completions matched on provider/id and display name, with prefix matches ranked ahead of substring matches.

### Per-invocation task model override

Spawn a subagent on an ad-hoc model: a concrete `provider/model[:thinking]`, a `@role` alias, or an ordered fallback chain — per-spawn, never persisted.

### sessionBootstrap

Inject user-configured context files into every session's prompt. It's a no-op when unset, and per-file failures warn but are never fatal.

## Quickstart

```
# Prereqs: bun (https://bun.sh) and git
git clone https://github.com/llvm-x86/loom.git
cd loom
bun install
cd packages/coding-agent && bun run build   # produces the compiled binary in dist/
install -m755 dist/loom ~/.local/bin/loom    # ensure ~/.local/bin is on PATH
loom --version
```

Then in any project directory just run `loom`.

(The compiled binary file may be named `dist/omp` or `dist/loom` depending on build config — if `dist/loom` is absent, use `dist/omp`.)

## Credits & license

Loom is built on [oh-my-pi](https://github.com/can1357/oh-my-pi) by can1357. See upstream oh-my-pi for license.
