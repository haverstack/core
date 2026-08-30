---
'@haverstack/core': minor
'@haverstack/sqlite-shared': minor
'@haverstack/record-adapter-sqlite': minor
'@haverstack/adapter-local': minor
'@haverstack/wire-types': minor
'@haverstack/adapter-api': minor
'@haverstack/conformance-fixtures': minor
---

Add an `unlisted` state for records — reachable by ID, absent from enumeration by default.

`StackRecord.unlistedAt` is a native field, orthogonal to `permissions`: it says nothing
about who may read a record, only whether it is enumerable. A record with `unlistedAt` set
is reachable by `get()` for anyone who may already read it, and excluded from an unfiltered
`query()` and the change feed by default — the same posture soft delete already has.

- `stack.create(typeId, content, { unlisted: true })` creates a record already unlisted, so
  there is no window where it exists and is briefly enumerable.
- `stack.setUnlisted(id, unlisted)` toggles it on an existing record, gated exactly like
  `setPermissions()` under `ScopedStack` — both decide who can discover a record, not merely
  read one already found.
- `RecordFilter.includeUnlisted` and `SubscribeOptions.includeUnlisted` opt a query or
  subscription back in. Unlike `includeDeleted`, `includeUnlisted` is refused to everyone but
  the stack owner acting alone under `ScopedStack` — enumeration standing rests on nothing but
  ownership, so no grant or delegation carries it.
- The change feed matches `query()`'s exclusion, with one exception: marking a record unlisted
  emits a dedicated `unlist` op (kind `deleted`) so a subscriber that already knows the record
  is told to drop it; relisting emits `list` (kind `changed`), an ordinary upsert like
  `undelete`. Every other transition — created unlisted, an edit while already unlisted, a
  purge of a record that was never listed — needs no special-casing, since it falls out of
  checking the record's current state.

See docs/spec/access-control.md § Unlisted records and docs/spec/events.md § The unlisted
transition.
