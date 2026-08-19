Search long-term memory for relevant information. Returns raw matching entries ranked by relevance.

Use proactively — before answering questions about past conversations, user preferences, project decisions, or any topic where prior context would help accuracy. When in doubt, recall first.

Prefer `recall` when you need specific facts or entries. Use `reflect` instead when you need a synthesized answer across many memories.

Content in each result is a preview. A trailing `…` marks a truncation (`truncated: true`, `full_length` gives the original size). Fetch the full row with `read memory://<id>` — required before any `memory_edit update`.

On the mnemopi backend, `repo` searches ANOTHER project's memory bank instead of this session's own — pass an `owner/repo` slug or a bank id, e.g. to pull context about a project you're not currently in. It is read-only and never affects what this session writes to. Pass `listBanks: true` (query optional) to see which banks exist on disk and how many memories each holds before picking one; each bank is also readable directly as files under `<treeRoot>/<bank>/`.
