Edit Mnemopi long-term memories by id.

Use only with ids returned by the `recall` tool. Operations:
- `update`: replace content and/or importance for a working memory.
- `replace`: swap `old_text` for `new_text` inside a working memory. `old_text` must match the stored content EXACTLY ONCE.
- `remove`: delete the `old_text` segment from a working memory (same exact-once rule).
- `forget`: permanently delete a working memory.
- `invalidate`: softly supersede a working or episodic memory, optionally pointing at `replacement_id`.

Fact ids (recall results marked `[facts]`) are read-only: inspect them with `read memory://<id>`; every edit op on a fact id returns `not_editable`.

Prefer `invalidate` when a memory became stale but its history may still be useful. Use `forget` only for content that should be hard-deleted.

**Prefer `replace` over `update` for targeted fixes.** `update` rewrites content wholesale; `replace(old_text, new_text)` changes only the named span and fails safely when the anchor is missing or ambiguous.

**Batch related edits in one call.** Pass `operations: [...]` (each item the same shape as a single call) to apply several edits atomically: the whole batch is validated against in-memory copies first, and ANY failure rejects the ENTIRE batch with the failing operation's index — no partial writes ever land.

**Always read the full memory before `update`.** Recall results are clipped previews (the trailing `…` marks a truncation and `full_length` reports the original size); `update` replaces content wholesale, so overwriting the preview would delete the unseen tail. Fetch the row first with `read memory://<id>`, then pass the merged content in `content`.

**Do NOT store (SKIP list):**
- Secrets, tokens, keys, credentials of any kind.
- Ephemeral task progress or scratch state — that belongs in session history, not long-term memory.
- Repeatable procedures — write a skill instead.
- Anything recoverable from git history or the repo itself.
