---
'@haverstack/core': minor
---

`associate()`, `dissociate()`, `setPermissions()` and `setUnlisted()` now return the record they produced

All four returned `Promise<void>` while every other version-bumping method on `StackClient` — `update()`, `undelete()`, `restoreVersion()`, `commitMigration()` — returns the record. Their wire endpoints already answer with a Record body (`docs/spec/wire-format.md` § Records) and `APIAdapter` already parses it, so the record was being fetched and then discarded. Callers can now report what they wrote without a second read.

A no-op (a duplicate association, removing one that isn't there, a deep-equal permission set, setting `unlistedAt` to the state it already holds) returns the record unchanged: what marks it a no-op is the version that didn't move, not an answer that never came.

`delete()` is deliberately unchanged — a hard delete leaves no record and no version to return.

This is source-compatible for callers that ignore the return value; it is breaking only for code that structurally implements `StackClient` itself.
