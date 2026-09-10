---
'@haverstack/core': minor
'@haverstack/wire-types': minor
'@haverstack/adapter-api': minor
'@haverstack/conformance-fixtures': minor
'@haverstack/record-adapter-sqlite': minor
'@haverstack/record-adapter-do-sqlite': minor
---

Make reparenting restorable, and settle what `parentId` spells and promises

A version snapshot now captures `parentId`, so a move rolls back like every other
mutation and the write bit's recoverability claim — anything a write-holder does,
the owner can undo — holds for `setParent()` too. `RecordVersion` and `WireVersion`
gain the field; `restoreVersion()` applies it.

A snapshot spells `parentId` exactly as the record does: **absent is the root.**
That follows the rule the field has always followed, now stated. Inputs spell the
root `null`, because they must tell the root from "not specified" — `setParent()`'s
argument, the `PUT /records/:id/parent` body, `RecordFilter`, `?parentId=null`.
State spells it by omission, because a record is always somewhere — `StackRecord`,
`RecordChange`, and now `RecordVersion`. `null` never appears on a snapshot; a
foreign server that sends the input spelling is read as the root rather than
misread. Because absence is the root rather than a missing claim, a restore always
settles containment: a snapshot carrying no `parentId` returns the record to the
root instead of leaving it where it sits.

A restore that puts a different container back is a move, and is treated as one
throughout. It is refused with `StackConflictError` (wire: 409) where it would make
the record its own ancestor, joining `setParent()` and a `create()` naming both its
own `id` and a `parentId` as the sites that walk the proposed chain. `ScopedStack`
applies the same reference gate to it that `setParent()` applies to a destination
named directly, so a restore cannot reach a container the requester could not name
today; a `parentId` the restore would not change is not re-gated, since the record
is already there, and a snapshot taken at the root names no container to gate. And
its change event is matched against both containers it concerns, exactly as a
`reparent` is — a subscription filtered on the origin learns the record left.

**Behavior change: a `parentId` a caller names must be well-formed and must name a
record that exists.** `setParent()` and `create()` now check format first
(`StackQueryError`, wire: 400) and then existence (`StackConflictError`, wire: 409).
Format is the rule a caller-supplied `id` already passes, so the empty string is not
a `parentId` any more than it is a record id. Code that relied on pointing at a
container before creating it, or on planting a reference to nothing, has to create
the container first. This is a front-door check rather than an invariant: deleting a
container never touches its children, so a `parentId` resolving to nothing remains
an ordinary state at rest and consumers must still handle one. What it buys is that
a caller cannot mint one — a dangling parent now means a container was removed.

**`restoreVersion()` is exempt from that check.** It is not a caller naming a
destination, it is history being put back, and the container may have been
hard-deleted since the snapshot was taken; refusing would let an unrelated deletion
cost a record its content rollback. It is the same stance restore takes on content,
validating against the snapshot's own `typeId` rather than the record's current one.
A restore is therefore the only write that can still produce a dangling parent.

**Behavior change: a chain deeper than the acyclicity walk's 64-level cap is no
longer refused.** The walk stops at the cap and the write proceeds. Depth is not
something the library bounds — an ordinary `create()` under a parent never walks,
and moving a subtree checks only the chain above it — so refusing there advertised a
guarantee that does not hold, and permanently froze a deep region against moves,
since nothing shortens a chain. The cap still bounds each move's cost and still
guarantees the walk terminates on a chain that is already cyclic. Acyclicity is a
guardrail against the common accident of moving a container into its own descendant:
exact for a single writer within the cap, and nothing beyond it. A consumer that
walks `parentId` must carry a visited set or a depth bound of its own.

`appId` remains uncaptured by snapshots. It names the software that authored the
record, a create-time fact no later write moves, so there is nothing for a rollback
to revert it to.

**Fixed:** nullable native fields are now read back by presence rather than
truthiness, so an empty-string `parentId`, `entityId`, `appId`, `principalId`,
`updatedBy` or `updatedVia`, and a `deletedAt` or `unlistedAt` at the epoch, survive
the round trip as the values they are. SQL NULL is the only spelling of an absent
field. The query predicates already read `IS NULL`, so the mapper disagreeing let
one record answer one way to `getRecord()` and another to the filter that should
have found it — an empty-string `parentId` read back as the root while
`parentId: null` did not match it, and a record deleted at the epoch dropped from
every query while `getRecord()` reported it live. `Stack.create()` carried the same
defect one layer up, dropping an empty-string id from the record it wrote.

**Fixed:** healing an orphaned version row — the snapshot an interrupted write left
behind at the record's current version — replaced only some of the row. `parent_id`,
`updated_by` and `updated_via` kept the orphan's values, so a later restore could
move a record into a container the healing snapshot never named, and the two
reference adapters disagreed about it.

**For adapter authors:** `StackAdapter.restoreVersion()`'s contract now states that
it restores the snapshot's `parentId` alongside content and associations, and that
an absent `parentId` means the root. An adapter written to the previous wording
would ignore containment on restore while `Stack` refused cycles and `ScopedStack`
refused moves against it.
