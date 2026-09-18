---
'@haverstack/core': minor
'@haverstack/wire-types': minor
'@haverstack/adapter-api': minor
'@haverstack/conformance-fixtures': minor
'@haverstack/record-adapter-sqlite': minor
---

Store record permissions as associations, behind a partitioned API surface

A permission entry has element identity, so the delta the association tier
already computes describes it exactly. `Permission` is replaced by two
association kinds — `permission`, whose bit is its label and whose grantee
carries a required `role`, and `anyone`, which spells reach to the world
affirmatively — and the whole-list snapshot goes with it. `RecordVersion` and
`WireVersion` lose `permissions`, the SQLite `versions` and `records` tables
lose their `permissions` columns, and `restoreVersion()` loses its
never-restores-permissions carve-out: it falls out of a restore never touching
associations.

Storage unifies; the API does not. `StackRecord.associations` and
`StackRecord.permissions` are projections over one table partitioned by kind,
and each change-set key replaces only within its own domain, so an app editing
tags is never handed the ACL and cannot drop it. A kind named in the wrong key
is a `StackQueryError`, `associate()`/`dissociate()` refuse authority kinds,
and record-level ACL changes get their own verbs — `grantAccess()` and
`revokeAccess()`, mirroring the type-level `grant()`/`revoke()`, with
`POST /records/:id/permissions[/delete]` on the wire.

The reshare gate reads the computed delta rather than the incoming list, so a
wholesale replacement that drops every element — which names nothing at all —
still needs reshare authority, while a set restated is not a reshare. _Write
implies read_ becomes a cross-element invariant over the set a write would
produce, which is what makes revoking a `read` refusable while its `write`
stands, and an `anyone` element satisfies it for every grantee — a
world-readable record leaves no writer blind. The rule it enforces is that no
write lands in a set whose grantee cannot read it, whichever verb or key
produced the set: withdrawing an `anyone` while a write it covered stands is
refused, while `permissions: []` and a key naming the writer's own `read` in
its place are ordinary one-call writes. A permission change is a no-bump write: it
leaves `version` and `updatedAt` where they stand and appends one journal entry
carrying `previous` per element it moved.

The journal is therefore where a record's sharing history lives, and reading it
is gated in two tiers: the mutate surface for the entry, reshare authority for
its authority half. A write-holder who is neither owner nor creator gets the
`permissions` op without the grantees beneath it, asked of both identities so
delegation is no route to it either. Entries are never dropped, so `seq` stays
dense and a mixed write still reports its content half.
`getVersions()`/`getVersion()` serve the same `RecordVersion` rows to every
requester who passes their gate, since a snapshot now carries nothing to
project.

An association naming no known kind — `null`, `{}`, or a kind outside the five
— is a `StackValidationError` at every surface that takes one, rather than a
`TypeError` from the first field read off it.
