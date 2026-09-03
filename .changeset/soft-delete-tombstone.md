---
'@haverstack/core': minor
---

Present a soft-deleted Record as a tombstone under `ScopedStack`, and refuse mutations aimed at one.

`get()` and `query({ includeDeleted: true })` return identity, clock, `version`, `deletedAt` and `permissions` with an empty `content` and no associations, `parentId` or authorship; the change feed carries the same projection, so no channel serves more of a deleted Record than a fetch by ID does. `permissions` is retained because it decides whether the caller may `undelete()`; history is deliberately exempt and still serves the content, since reviewing a Record is how a caller decides to restore it.

`update()`, `associate()`, `dissociate()`, `setPermissions()`, `setUnlisted()` and `restoreVersion()` now throw `StackConflictError` on a soft-deleted Record — asked after the authority decision, so a requester who cannot read it still gets `StackNotFoundError` rather than learning the ID names something. `undelete()` and `commitMigration()` are unaffected.

This resolves a contradiction between the spec's two accounts of soft delete: `versioning.md` called a soft-deleted Record a tombstone whose "current state is gone" while the implementation served it whole.
