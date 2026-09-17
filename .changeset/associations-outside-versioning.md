---
'@haverstack/core': minor
'@haverstack/adapter-api': minor
'@haverstack/adapter-local': minor
'@haverstack/record-adapter-sqlite': minor
'@haverstack/record-adapter-do-sqlite': minor
'@haverstack/wire-types': minor
---

Associations no longer bump `version`, snapshot, or restore

**`associate()`/`dissociate()` — and a change set whose only key is
`associations` — no longer bump a Record's `version`, touch `updatedAt`, or
write a version snapshot.** Content mutation is destructive the instant it
lands, which is what version history exists to make recoverable.
Associations aren't: the inverse operation is the same shape as the
forward one and reconstructs the prior state exactly (an
attachment-annotation overwrite is the one minor exception), so they never
needed the rollback machinery.

```ts
const before = await stack.get(record.id);
await stack.associate(record.id, { kind: 'tag', label: 'starred' });
const after = await stack.get(record.id);
after.version === before.version; // true — this used to bump
```

They still appear on the change feed (`docs/spec/events.md`) as
`associate`/`dissociate` ops, so a subscriber still hears about them — the
event just carries the record's unchanged `version`/`updatedAt`, and its
`actor` now travels as an explicit fact about the call rather than being
read off a record field these calls no longer stamp.

**`associate()`/`dissociate()` drop `ifVersion` entirely — this is a
breaking signature change.** A set-add/remove composes correctly
regardless of write order, so there was never a race for the precondition
to guard, and offering one that could no longer trigger a bump would just
be silently useless. `mutate()` follows the same line, read off the keys a
change set names: one whose only key is `associations` carries no
precondition either, so an `ifVersion` passed alongside it is not checked.
A change set that names any other aspect is unaffected — `ifVersion` still
fences the whole call, same as ever, including where that aspect restates
what the record already holds and the call writes nothing.

**`restoreVersion()` never restores associations, for any Record type —
this generalizes what used to be a `_group`-only carve-out.** A `_group`'s
roster already didn't roll back, on the grounds that a roster is authority
rather than data; that reasoning turned out to apply to every Record's
associations, not just a group's. `RecordVersion` drops the `associations`
field entirely — no snapshot has ever captured one since associate()/
dissociate() stopped bumping, so there was nothing left for a restore to
read one back from. `restoreAssociations` is gone from every
`restoreVersion()` options type; it's unconditional now, and needs no more
flag than `permissions`, which restore has never touched.

**Adapter contract:** `StackRecordAdapter.associate()`/`dissociate()` drop
their `opts` parameter — no `ifVersion`, snapshot, or actor stamping,
since none of it applies to a write that never bumps. `mutateRecord()`
gains `opts.bumpsVersion` (computed by `Stack`, not inferred by the
adapter) so a change set naming only `associations` can skip the
records-table update and snapshot entirely. `restoreVersion()` drops
`restoreAssociations` — an adapter no longer receives an association list
to restore from in the first place.

**Wire protocol:** the association endpoints (`POST /records/:id/associations`,
`POST /records/:id/associations/delete`) no longer accept `If-Match` — same
reasoning as the local `ifVersion` drop. `WireVersion` drops
`associations`. A `PATCH /records/:id` change set naming only
`associations` no longer bumps `version` either, matching the standalone
endpoints, and an `If-Match` sent with such a body is not checked.
