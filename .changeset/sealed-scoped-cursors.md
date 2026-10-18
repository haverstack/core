---
'@haverstack/core': minor
---

Seal the cursor `ScopedStack.query()` returns. The adapter's cursor names the last record a page scanned, by ID and sort value, so a scoped query could hand any requester — anonymous included — the IDs, creation times and content-sort values of records it may not read, and a forged cursor could search those values. A scoped cursor is now AES-GCM sealed under `_config.cursorKey`, minted on first use and immutable once set, and only a cursor the stack sealed resumes; anything else is a 400. `_config` can no longer be shared, and a permission element on it reaches nobody. `MemoryAdapter` now stores the `_config` record the SQLite engines do.
