One tool for every memory change. The agent never writes memory files directly —
the background memory system owns the whole tree; this tool only files a request
that the background materializes.

**The memory tree.** Your memories are rendered as markdown files under the
memory tree root (setting `mnemopi.treeRoot`; default `<agent memories>/tree`).
Every memory bank — one per project, plus the shared `default` bank — gets its
own subdirectory, so projects can never clobber each other's files:

- `MEMORY.md` at the root — cross-project index: one line per bank directory
  found on disk (bank id, leaf count, updated). This is how you discover other
  projects' memory: read/grep `<bank>/` directly with your normal file tools,
  the same as any other project's files — no tool call needed to cross into it.
- `<bank>/MEMORY.md` — entry point for that bank: one line per subtree.
- `<bank>/<subtree>/MEMORY.md` — entry point per subtree: leaf headers
  (summary, tags, status, updated).
- `<bank>/<subtree>/<slug>.md` — the leaves themselves.
- `<bank>/archive/<subtree>/<slug>.md` — leaves whose bank row was archived.

Read memory like you read any files: `read MEMORY.md` for the cross-project
index, then a bank's `MEMORY.md`, then a subtree's `MEMORY.md`, then the
leaves whose summary matches the task, then follow their `connections`.
Cross-rank summaries against the current task before opening a leaf; open
leaves in full only after the summary looks relevant.

**Actions**

- `add` — record a new memory. `content` is the text; `target` files it under
  a subtree (e.g. `projects/agent-chat`, `concepts`, `people`, `skills`);
  `context` attaches provenance; `importance` is a 0–1 hint.
- `repo` (any action) — the `owner/repo` this memory belongs to, e.g.
  `Family-Fun-Group/SkyRail`. Pass it whenever the memory is about a specific
  repository, especially outside a git checkout of it (e.g. a console
  session). Unlike `target` (where in the tree it's filed), `repo` picks
  *which* memory bank it's stored in — and once declared, it's sticky: later
  calls that omit it keep using the same bank for the rest of the session.
- `replace` — update an existing memory. `match` is a substring that uniquely
  identifies it (first content match wins); `content` is the new text.
- `remove` — delete a memory identified by `match`.
- `restore` — bring an archived memory (one rendered under `archive/`) back to
  active, identified by `match`.

The background renderer writes the leaf + entry points on its next pass, and
hand-edits to the tree are adopted back into the ledger rather than clobbered.
