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
stands. A permission change is a no-bump write: it leaves `version` and
`updatedAt` where they stand and appends one journal entry carrying `previous`
per element it moved. `getVersions()`/`getVersion()` correspondingly serve the
same rows to every requester who passes their gate.
