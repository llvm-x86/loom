One tool for every memory change. The agent never writes memory files directly —
the background memory system owns the whole tree; this tool only files a request
that the background materializes.

**The memory tree.** Your memories are rendered as markdown files under the
memory tree root (setting `mnemopi.treeRoot`; default `<agent memories>/tree`):

- `MEMORY.md` at the root — entry point: one line per subtree.
- `<subtree>/MEMORY.md` — entry point per subtree: leaf headers (summary, tags,
  status, updated).
- `<subtree>/<slug>.md` — the leaves themselves.
- `archive/<subtree>/<slug>.md` — leaves whose bank row was archived.

Read memory like you read any files: `read MEMORY.md`, then a subtree's
`MEMORY.md`, then the leaves whose summary matches the task, then follow their
`connections`. Cross-rank summaries against the current task before opening a
leaf; open leaves in full only after the summary looks relevant.

**Actions**

- `add` — record a new memory. `content` is the text; `target` files it under
  a subtree (e.g. `projects/agent-chat`, `concepts`, `people`, `skills`);
  `context` attaches provenance; `importance` is a 0–1 hint.
- `replace` — update an existing memory. `match` is a substring that uniquely
  identifies it (first content match wins); `content` is the new text.
- `remove` — delete a memory identified by `match`.
- `restore` — bring an archived memory (one rendered under `archive/`) back to
  active, identified by `match`.

The background renderer writes the leaf + entry points on its next pass, and
hand-edits to the tree are adopted back into the ledger rather than clobbered.
