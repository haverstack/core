---
'@haverstack/core': minor
'@haverstack/adapter-api': minor
'@haverstack/adapter-local': minor
'@haverstack/record-adapter-sqlite': minor
'@haverstack/record-adapter-do-sqlite': minor
'@haverstack/conformance-fixtures': minor
---

Add `setParent()` — records can be moved between containers after creation

`parentId` was settable at create and nowhere else: `update()` is a content-only
merge patch, `patchContent()` is content-only by contract, and `PATCH /records/:id`
carries the content patch as its whole body. A record's place in the hierarchy was
therefore fixed for life, and a `parentId` key in an `update()` patch was stored as
a content field of that name instead.

`setParent(id, parentId | null)` joins `setUnlisted()` and `setPermissions()` as a
native-field verb — `null` moves a record to the root. It bumps `version`, snapshots
the prior state, takes `ifVersion`, and travels as `PUT /records/:id/parent`.
`StackAdapter` gains a matching `setParent()`; every bundled adapter implements it.

Moving a record confers nothing: containment is not an access-control edge, so
nothing is inherited from a container and nothing cascades out of one. `ScopedStack`
gates a move as an ordinary write on the record plus read access to the destination —
the same reference gate `create()` applies to a `parentId`. The origin is ungated,
since naming it requires reading the record.

An edge that would make a record its own ancestor is refused with `StackConflictError`
(wire: 409), at both sites that add one: `setParent()`, and a `create()` supplying both
`id` and `parentId` — a generated id names nothing, but a caller-supplied one may already
have records pointing at it. Dangling parents stay legal. The check is read-then-write, so
it is advisory under concurrency, the same posture as DID binding uniqueness; consumers
that walk `parentId` should carry a visited set.

The change feed gains a `reparent` op (kind `changed`), matched against both
containers a move concerns so a subscription filtered on the origin learns the record
left it. Frames carry the destination in `parentId`, as every frame carries the
record's state at the moment of the change; a subscriber compares it to its own
filter to tell a departure from an arrival.
