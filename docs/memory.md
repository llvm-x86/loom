# Autonomous Memory

When the local memory backend is enabled, the agent automatically extracts durable knowledge from past sessions and injects a compact summary into future sessions for the same project. Over time it builds a project-scoped memory store — technical decisions, recurring workflows, pitfalls — that carries forward without manual effort.

Disabled by default. Enable the local summary pipeline via `/settings` or `config.yml`:

```yaml
memory:
  backend: local
```

## Usage

### What gets injected

At session start, if a memory summary exists for the current project, it is injected into the system prompt as a **Memory Guidance** block. The agent is instructed to:

- Treat memory as heuristic context — useful for process and prior decisions, not authoritative on current repo state.
- Cite the memory artifact path when memory changes the plan, and pair it with current-repo evidence before acting.
- Prefer repo state and user instruction when they conflict with memory; treat conflicting memory as stale.

### Reading memory artifacts

The agent can read memory files directly using `memory://` URLs with the `read` tool:

| URL                                    | Content                             |
| -------------------------------------- | ----------------------------------- |
| `memory://root`                        | Compact summary injected at startup |
| `memory://root/MEMORY.md`              | Full long-term memory document      |
| `memory://root/skills/<name>/SKILL.md` | A generated skill playbook          |

### `/memory` slash command

| Subcommand            | Effect                                                    |
| --------------------- | --------------------------------------------------------- |
| `view`                | Show the current backend injection payload                |
| `stats`               | Show backend-specific memory statistics, when supported   |
| `diagnose`            | Show backend-specific diagnostics, when supported         |
| `clear` / `reset`     | Delete active backend memory data/artifacts               |
| `enqueue` / `rebuild` | Force consolidation/retention work for the active backend |

## How it works

Local summary memories are built by a background pipeline that runs at startup; `/memory enqueue` marks consolidation work that the next startup picks up. The pipeline is skipped for subagents and for sessions that are not persisted to a session file.

**Phase 1 — per-session extraction:** For each past session that has changed since it was last processed, a model reads the session history and extracts durable signal: technical decisions, constraints, resolved failures, recurring workflows. Sessions that are too recent, too old, currently active, or beyond the configured scan/age limits are skipped. Each extraction produces a raw memory block and a short synopsis for that session.

**Phase 2 — consolidation:** After extraction, a second model pass reads all per-session extractions and produces three outputs written to disk:

- `MEMORY.md` — a curated long-term memory document
- `memory_summary.md` — the compact text injected at session start
- `skills/` — reusable procedural playbooks, each in its own subdirectory

Phase 2 uses a lease and heartbeat to prevent double-running when multiple processes start simultaneously. Stale skill directories from prior runs are pruned automatically.

Consolidated output is redacted for common secret/token patterns before `MEMORY.md`, `memory_summary.md`, or generated skills are written to disk.

### Extraction behavior

Memory extraction and consolidation behavior is driven by static prompt files in `packages/coding-agent/src/prompts/memories/`.

| File                     | Purpose                                      | Variables                                   |
| ------------------------ | -------------------------------------------- | ------------------------------------------- |
| `stage_one_system.md`    | System prompt for per-session extraction     | —                                           |
| `stage_one_input.md`     | User-turn template wrapping session content  | `{{thread_id}}`, `{{response_items_json}}`  |
| `consolidation_system.md`| System prompt for cross-session consolidation | —                                          |
| `consolidation.md`       | User-turn prompt for cross-session consolidation | `{{raw_memories}}`, `{{rollout_summaries}}` |
| `read-path.md`           | Memory guidance injected into live sessions  | `{{memory_summary}}`, `{{learned}}`         |

### Model selection

Memory piggybacks on the model role system.

| Phase                   | Role                                                                | Purpose                          |
| ----------------------- | ------------------------------------------------------------------- | -------------------------------- |
| Phase 1 (extraction)    | `default`                                                           | Per-session knowledge extraction |
| Phase 2 (consolidation) | `smol` (falls back to `default`, then current/first registry model) | Cross-session synthesis          |

If the requested memory role is not configured, memory model resolution falls back to the `default` role, then the active session model, then the first model in the registry.

## Configuration

| Setting                               | Default | Description                                                                                                                              |
| ------------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `memory.backend`                      | `off`   | Select `local` for this pipeline; legacy `memories.enabled: true` is migrated to `memory.backend: local` when no explicit backend is set |
| `memories.maxRolloutAgeDays`          | `30`    | Sessions older than this are not processed                                                                                               |
| `memories.minRolloutIdleHours`        | `12`    | Sessions active more recently than this are skipped                                                                                      |
| `memories.maxRolloutsPerStartup`      | `64`    | Cap on sessions processed in a single startup                                                                                            |
| `memories.summaryInjectionTokenLimit` | `5000`  | Max tokens of the summary injected into the system prompt                                                                                |

Additional tuning knobs (concurrency, lease durations, token budgets) are available in config for advanced use.

## Mnemopi memory tree

Under `memory.backend: mnemopi` (the default), long-term memory is rendered as a
**background-maintained file tree** the agent reads with its normal file tools:

```text
<treeRoot>/
  MEMORY.md                      entry point: subtree rollup
  <subtree>/MEMORY.md            entry point: leaf headers for the subtree
  <subtree>/<slug>.md            leaf (YAML-lite header + ≤4KB body)
  archive/<subtree>/<slug>.md    leaves whose bank row is archived
```

The mnemopi SQLite bank is the source of truth; every file under the tree is a
pure projection of it. Working agents never write tree files: they read the
index → subtree entry points → leaf bodies with `read`/`glob`/`grep`, and
request changes through the single `memory` tool:

| Action    | Effect                                                        |
| --------- | ------------------------------------------------------------- |
| `add`     | Record one fact (optionally under a `target` subtree)         |
| `replace` | Update the content of the memory matching a substring         |
| `remove`  | Delete the memory matching a substring                        |
| `restore` | Bring an archived memory back to the active tree              |

The tool mutates the bank and schedules a render; the background reconcile pass
writes the leaf + entry points. Renders are idempotent. External hand-edits to a
leaf whose file mtime is newer than its bank row are adopted back into the bank
(body wins, metadata stays background-owned); stale leaves are removed; archived
rows render under `archive/`. Deleting the whole tree is safe — the next pass
re-materialises it.

Tool surfaces under mnemopi: `recall`/`retain`/`reflect` gate on
`memory.backend: hindsight`, and `memory_edit` is inert — the `memory` tool is
the single write channel for the tree backend. Turn retentions and
consolidations still feed the bank and drive re-renders automatically.

## Configuration

| Setting                                | Default | Description                                                            |
| -------------------------------------- | ------- | ---------------------------------------------------------------------- |
| `mnemopi.treeEnabled`                  | `true`  | Render the bank as the file tree on retain/consolidate passes          |
| `mnemopi.treeRoot`                     | *derived* | Root of the memory tree (`<memories>/tree` when unset)               |
| `mnemopi.treeLeafCharCap`              | `4096`  | Per-leaf body cap in characters (min 512)                              |

## Key files

- `packages/coding-agent/src/memories/index.ts` — pipeline orchestration, injection, clear/enqueue entry points (the `/memory` command routes here via `packages/coding-agent/src/memory-backend/local-backend.ts`)
- `packages/coding-agent/src/memories/storage.ts` — SQLite-backed job queue and thread registry
- `packages/coding-agent/src/prompts/memories/` — memory prompt templates
- `packages/coding-agent/src/internal-urls/memory-protocol.ts` — `memory://` URL handler
