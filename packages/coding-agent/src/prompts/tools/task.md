{{#if asyncEnabled}}{{#if batchEnabled}}Delegate work to background subagents by passing multiple items in a single `tasks[]` batch.
Execution does not block — you receive IDs immediately.{{else}}Delegate work to ONE background subagent per call.
Execution does not block — you receive an ID immediately.{{/if}}{{#if hasBlockingAgents}}
Agents marked BLOCKING run inline — results return in this call; non-blocking items in the same batch still spawn as background jobs.{{/if}}{{else}}{{#if batchEnabled}}Run subagents synchronously by passing items in a `tasks[]` batch. Execution blocks until all work finishes.{{else}}Run ONE subagent synchronously. Execution blocks until work finishes.{{/if}}{{/if}}
{{#if asyncEnabled}}

# Async Job Contract
- Results auto-deliver. A settled `hub jobs`/`hub wait` snapshot is the delivery; no duplicate `async-result` follows.
- Job IDs are process-local and expire roughly five minutes after settlement. Afterward, use the agent ID with `hub send`, `agent://<id>`, or `history://<id>`.
- `completed` means successful yield/job exit, not artifact acceptance. Verify claimed changes.
{{/if}}

# Task Design
- **Agent typing:** Pick each item's `agent` type. Read-only research MUST use `agent: "scout"` (faster model). Use default worker only when no specialist fits.
- **No overhead:** Each `task` MUST instruct its agent to skip formatters, linters, and project-wide test suites. Run those once at the end.
- **One-pass:** Prefer agents that investigate AND edit in one pass; spin a read-only scout only when affected files are genuinely unknown.

# Inputs
{{#if batchEnabled}}
- `context`: Shared project state, constraints, and contracts. Applies to the entire batch; do not duplicate this background into individual tasks.
- `tasks[]`: Array of subagents to spawn.
  - `name`: A stable CamelCase identifier (≤32 chars), used to address the agent (IRC, job ids). Generated automatically if omitted.
  - `agent`: The agent type running this item (e.g. `scout`, `reviewer`). Omitting it gives you the general-purpose worker (`{{defaultAgent}}`) — NEVER pass that name explicitly. Only omit it after checking the agent list below and finding no specialist that fits.{{#if allowedAgentsText}} Current spawn policy allows: {{allowedAgentsText}}.{{/if}}
  - `task`: Complete, self-contained instructions. One-liners or missing acceptance criteria are PROHIBITED.
  - `model`: Optional per-subagent model override for this spawn only. Accepts a concrete model pattern (`provider/model-id`, optional `:<thinkingLevel>` suffix, same syntax as agent frontmatter `model:`), a role alias like `@smol`, or an array for an ordered fallback chain. Use it when the user asks for a specific model or when a step needs a different strength/cost profile. Omit to inherit the agent type's configured model.
  - `outputSchema`: Invocation-specific JSON Schema. Overrides the selected agent and parent-session schemas.
  - `schemaMode`: `"permissive"` (default) accepts a retry-exhausted invalid result with a warning; `"strict"` fails it.
{{#if isolationEnabled}}
{{#if isolationRequired}}
  - `isolated`: Every item runs in its own dedicated worktree and returns patches, merged back into the repo when the item finishes. This is MANDATORY — `isolated: false` is refused at preflight. Two items sharing one working tree means uncommitted work has no owner: a destructive git command in one silently reverts the other's edits with no error, and file-level assignments between items do not prevent it.
{{else}}
{{#if isolationByDefault}}
  - `isolated`: Runs in a dedicated worktree and returns patches — **this is the DEFAULT for every item**. Your edits land in that worktree and are merged back into the repo when the item finishes; the worktree is destroyed on completion and the agent cannot be addressed afterward. Pass `isolated: false` for an item that MUST write directly to the live working tree (e.g. it drives a running dev server or edits files another live process is watching).
{{else}}
  - `isolated`: Run in dedicated worktree, return patches. Destroyed on completion, cannot be addressed afterward.
{{/if}}
{{/if}}
{{/if}}
{{else}}
- `name`: A stable CamelCase identifier (≤32 chars), used to address the agent (IRC, job ids). Generated automatically if omitted.
- `agent`: The agent type to spawn (e.g. `scout`, `reviewer`). Omitting it gives you the general-purpose worker (`{{defaultAgent}}`) — NEVER pass that name explicitly. Only omit it after checking the agent list below and finding no specialist that fits.{{#if allowedAgentsText}} Current spawn policy allows: {{allowedAgentsText}}.{{/if}}
- `task`: Complete, self-contained instructions. One-liners or missing acceptance criteria are PROHIBITED.
- `model`: Optional per-subagent model override for this spawn only. Accepts a concrete model pattern (`provider/model-id`, optional `:<thinkingLevel>` suffix, same syntax as agent frontmatter `model:`), a role alias like `@smol`, or an array for an ordered fallback chain. Use it when the user asks for a specific model or when a step needs a different strength/cost profile. Omit to inherit the agent type's configured model.
- `outputSchema`: Invocation-specific JSON Schema. Overrides the selected agent and parent-session schemas.
- `schemaMode`: `"permissive"` (default) accepts a retry-exhausted invalid result with a warning; `"strict"` fails it.
{{#if isolationEnabled}}
{{#if isolationRequired}}
- `isolated`: Every spawn runs in its own dedicated worktree and returns patches, merged back when it finishes. This is MANDATORY — `isolated: false` is refused at preflight. Two subagents sharing one working tree means uncommitted work has no owner: a destructive git command in one silently reverts the other's edits with no error.
{{else}}
{{#if isolationByDefault}}
- `isolated`: Runs in a dedicated worktree and returns patches — **this is the DEFAULT**. Your edits land in that worktree and are merged back into the repo when the spawn finishes. Pass `isolated: false` when the subagent MUST write directly to the live working tree.
{{else}}
- `isolated`: Run in dedicated worktree, return patches.
{{/if}}
{{/if}}
{{/if}}
{{/if}}

# Model Reproducibility
Always pin `model` explicitly (per item or top-level) when reproducibility matters: spawned subagent CLIs resolve models independently and do NOT inherit an interactive session's /model selection; ambient resolution can fail with "No model selected" in environments configured only interactively. An explicit model is validated at preflight and fails loudly — never silently substituted.

# Communication
Subagents start blank — no conversation history.{{#if ircEnabled}} Parent-to-subagent IRC delivered immediately as steering.{{/if}}
Pass large payloads via `local://<path>` URIs, NEVER inline text.

# Format Contracts
{{#if batchEnabled}}
`context` format:
# Goal         ← what the batch accomplishes
# Constraints  ← rules and session decisions
# Contract     ← shared interfaces
{{/if}}

`task` format:
# Target       ← exact files and symbols; explicit non-goals
# Change       ← step-by-step add/remove/rename; APIs and patterns
# Acceptance   ← observable result; no project-wide commands

# Available Agents
{{#if spawningDisabled}}
Agent spawning is currently disabled.
{{else}}
Pick the most specific agent; use default worker only when no specialist fits.
{{#list agents join="\n"}}
### {{name}}{{#if readOnly}} (READ-ONLY){{/if}}{{#if blocking}} (BLOCKING: inline result){{/if}}
{{description}}
{{#if readOnly}}Use ONLY for investigation; do edits yourself or assign to a writing agent.{{/if}}
{{/list}}
{{/if}}
