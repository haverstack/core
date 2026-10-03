---
'@haverstack/core': minor
---

`Stack.get()` and `ScopedStack.get()` hide soft-deleted records by default, as `query()` does: `get(id)` on a tombstone answers `null`. Pass `{ includeDeleted: true }` to read it back. Adds `parseGetRecordParams()` for `GET /records/:id`.
