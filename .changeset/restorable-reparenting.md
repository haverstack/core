---
'@haverstack/core': minor
'@haverstack/wire-types': minor
'@haverstack/adapter-api': minor
'@haverstack/conformance-fixtures': minor
'@haverstack/record-adapter-sqlite': minor
'@haverstack/record-adapter-do-sqlite': minor
'@haverstack/sqlite-shared': minor
---

Make reparenting restorable — `restoreVersion()` puts a record back in the container the snapshot was taken in

A version snapshot now captures `parentId`, so a move rolls back like every other
mutation and the write bit's recoverability claim — anything a write-holder does,
the owner can undo — holds for `setParent()` too. `RecordVersion` and `WireVersion`
gain the field; `restoreVersion()` applies it.

The field is nullable rather than merely optional, and the two spellings differ:
`null` is the root, and an absent key is a snapshot claiming nothing about
containment, which restores to no move. That is the same three states
`associations` already carries, and absence is what a foreign server's snapshot or
a hand-built `saveVersion()` looks like — never one this library writes.

A restore that puts a different container back is a move, and is treated as one
throughout. It is refused with `StackConflictError` (wire: 409) where it would make
the record its own ancestor, joining `setParent()` and a `create()` naming both its
own `id` and a `parentId` as the sites that walk the proposed chain. `ScopedStack`
applies the same reference gate to it that `setParent()` applies to a destination
named directly, so a restore cannot reach a container the requester could not name
today; a `parentId` the restore would not change is not re-gated, since the record
is already there. And its change event is matched against both containers it
concerns, exactly as a `reparent` is — a subscription filtered on the origin learns
the record left.

Snapshot `parentId` is not stripped from history for non-owners, unlike snapshot
`permissions`: it is the same class of fact as the `relationship` targets a
snapshot's `associations` already carry, and a write-holder who is to undo a move
has to be able to see the one that happened.

`appId` remains uncaptured. It names the software that authored the record, a
create-time fact no later write moves, so there is nothing for a rollback to revert
it to.

**Fixed, in the SQLite adapters:** a record's nullable native fields are now read
back by presence rather than truthiness, so an empty-string `parentId`, `entityId`,
`appId`, `principalId`, `updatedBy` or `updatedVia`, and a `deletedAt` or
`unlistedAt` at the epoch, survive the round trip as the values they are. SQL NULL
is the only spelling of an absent field. The query predicates already read
`IS NULL`, so the mapper disagreeing let one record answer one way to `getRecord()`
and another to the filter that should have found it — an empty-string `parentId`
read back as the root while `parentId: null` did not match it, and a record deleted
at the epoch dropped from every query while `getRecord()` reported it live.
