# Issue plan

How to turn [CONCLUSIONS.md](./CONCLUSIONS.md) into issues, and in what order to work them. `#n` below means finding _n_ in CONCLUSIONS.md, not a GitHub issue.

Each issue body should carry its decision, reasoning and action list from CONCLUSIONS.md, not a link to it, since this file lives on an unmerged branch.

## Tracking issue

**Reading list API findings: tracking**

Links FINDINGS.md's verdict, lists every issue below as a sub-issue grouped by the tracks, and records the order. It also records the decisions made after CONCLUSIONS.md was written:

- Adding `enum` values is additive (I-12).
- `getVersions()` is paged (I-4).

And the one existing follow-up: app manifests (#359).

## Merges and splits

| Finding | Becomes          | Why                                                                                                                                                                            |
| ------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| #1      | I-3, I-4         | The ordering fix is small and settled. Paging is a contract change that needs its own design.                                                                                  |
| #3      | folded into I-8  | Its code half _is_ #6. Its spec half is one sentence in the same `versioning.md` section.                                                                                      |
| #5      | I-10, I-12, I-13 | Three separable changes. Nullability and `enum` each change validation and the spec on their own, and the type handles build on both.                                          |
| #8, #9  | I-14, I-15, I-16 | They share one adapter contract (`amendAssociations`), one wire body (`{ changes }`) and one type (`AssociationEdit`). Split by layer, not by finding, so each PR is coherent. |

Everything else is one issue per finding.

## Issues, in the recommended order

Order is by dependency first, then to minimise churn: sweeping mechanical changes go early so later tests are written against the final API, and README work goes last so the READMEs are written once.

### Track A: independent contract fixes

**I-1. `feat(core)!: open adapters with a single async open()`** (#13)
Every adapter that holds identity gets `static open(opts)` with a `create` mode, and a shared `OwnerMismatchError`. `MemoryAdapter` becomes `await MemoryAdapter.open({ ownerEntityId })`.
_First because_ it rewrites the setup of every test file in every package. Landing it before anything else means every later issue writes its tests against the final constructor, instead of this PR rebasing across all of them.
Packages: core, record-adapter-sqlite, adapter-local, record-adapter-do-sqlite, adapter-api, adapter-conformance (harness).

**I-2. `feat(core)!: rename change kind deleted to removed`** (#15)
Mechanical rename across core, sqlite-shared's `CHECK`, conformance and fixtures. No dependencies. Early for the same reason as I-1: it touches expected values in many tests.

**I-3. `fix(core): getVersions() returns newest first on every adapter`** (#1)
MemoryAdapter change, conformance test, fixture check, spec.

**I-4. `feat(core)!: page getVersions()`** (#1, open question)
`getVersions(id, { limit, beforeVersion })`, newest first, with the same paging shape as `getJournal()` (default limit, cursor, how the next page is signalled). Adapter contract and every adapter, `GET /records/:id/versions` query params, fixtures, conformance, `versioning.md` and `wire-format.md`. `ReadingList.history()` reads the first page.
_After I-3_: a `beforeVersion` cursor only makes sense once the order is fixed.

**I-5. `feat(core)!: a named sort defaults to asc`** (#10)
Sort normalisation in `Stack`, adapters drop their defaults, list-orders table in the spec.
_After I-3_ because the table states `getVersions()` as newest first.

**I-6. `fix(blob-adapter-disk): getBlob() returns a plain, independent Uint8Array`** (#4)
Disk adapter, MemoryAdapter copying, stricter conformance tests. No dependencies; can go anywhere in the order.

### Track B: tombstones

**I-7. `fix(core): refuse edits to a soft-deleted record on unscoped Stack`** (#2)
Move the check from `ScopedStack.refuseIfDeleted()` into `Stack`.

**I-8. `feat(core)!: get() hides soft-deleted records unless includeDeleted`** (#6, #3)
Includes the `delete()` wording fix from #3 and the wire `?includeDeleted=`.
_After I-7_: its tests assert that mutating a tombstone is `409` on both surfaces, which is only true once I-7 lands, and its audit of internal `get()` callers should include the check I-7 adds to `Stack`.

### Track C: content and schema

**I-9. `feat(core)!: family arguments take a BaseId and refuse a TypeId`** (#7)
`migrateAll`, `grantType`/`revokeType`, `RecordFilter.baseId`, `GrantContent.typeId` → `baseId`, `_grant` validation on every write, evaluation-time refusal.
_Before I-13_ so the type handle's `baseId` lands into an API that already requires it. The reading-list update uses a string family for now and switches to `Book.baseId` in I-13.

**I-10. `feat(core)!: content fields are never null`** (#5, nullability part)
Drop `null`/`undefined` on `create()` and `commitMigration()`, `create()` returns stored content, conformance tests.

**I-11. `feat(core)!: content must be plain JSON; refuse Date with guidance`** (#11)
_After I-10_: the JSON-value check runs after null dropping, and the message relies on `create()` returning stored content.

**I-12. `feat(core): string fields can declare enum`** (#5, enum part)
Validation, drift rules, canonical hashing (sorted), wire-types / adapter-api / fixtures.
Drift rules: adding an `enum` or removing values narrows (version bump); removing an `enum` or adding values widens (additive).

**I-13. `feat(core): typed content through type handles`** (#5, handles part)
`ContentOf`, `PatchOf`, `typeHandle()`, typed `StackClient` overloads, `defineType()` accepting a handle, type tests, reading list moves to handles.
_After I-9, I-10 and I-12_: the derived types assume non-nullable fields and enum unions, and the handle carries `baseId`.
Because adding `enum` values is additive, a typed read can receive a value its handle's union excludes. This issue has to decide what happens then: validate enum fields against the handle's schema on read and throw, or derive a wider type (e.g. `'want' | … | (string & {})`) so callers must handle unknown values.

### Track D: associations

**I-14. `feat(core)!: journal remove changes name their subject association`** (#9, rename part)
Rename `remove.previous` → `association`, export `AssociationEdit`. Journal spec, fixtures, conformance assertions. Small and standalone.

**I-15. `feat(core)!: adapters apply association changes atomically via amendAssociations()`** (#8 and #9, adapter and wire part)
Replace the adapter's `associate()`/`dissociate()` with `amendAssociations(id, changes)` in MemoryAdapter, sqlite-shared and APIAdapter. Wire: `POST …/associations` and `…/permissions` take `{ changes }`, the `/delete` sub-paths go. `Stack`'s existing single-element verbs route through it unchanged.
_After I-14_ (uses `AssociationEdit`). The wire change has to land here because `APIAdapter.amendAssociations()` needs a one-request endpoint.

**I-16. `feat(core)!: list-taking association and access verbs`** (#8 and #9, public API part)
`grantAccess`/`revokeAccess`/`associate`/`dissociate` take arrays; new `amendAssociations()`/`amendAccess()`; list rules; post-state checks once; one journal entry; `repoint` refusal; actionable write-implies-read messages. Reading list `letEdit` and `setCover`.
_After I-15, and after I-7_ so the new verbs inherit the tombstone refusal from `Stack` rather than needing their own.

**I-17. `feat(core)!: every permission refusal says what was refused`** (#14)
Required message on `StackPermissionError`, specific denials, reference-gate wording.
_After I-16_ so the message audit covers `amendAccess()`'s reshare gate and the reworded access refusals in one pass. Otherwise independent.

### Track E: documentation

**I-18. `docs: POST /types is owner-only; document the setup/data split`** (#16)
Spec rule for `POST /types`, "Writing an app" README section, split `installReadingList()`.
The spec half can land any time. Do the README half last so it shows the final construction (I-1), handles (I-13) and verbs (I-16).

**I-19. `docs: unfiltered queries return every readable record`** (#12)
`data-model.md § Filter` and a sentence in both quick starts.
Last, alongside I-18, since both edit the same README quick starts and the `§ Filter` text should also reflect I-8's `get()` default.

## Summary order

1. I-1 adapter construction
2. I-2 `removed` kind
3. I-3 `getVersions()` order
4. I-4 `getVersions()` paging
5. I-5 sort defaults
6. I-6 blob bytes
7. I-7 tombstone refusal in `Stack`
8. I-8 `get()` hides tombstones (+ #3)
9. I-9 `BaseId` for families
10. I-10 non-nullable content
11. I-11 plain-JSON content, `Date` refusal
12. I-12 `enum`
13. I-13 type handles
14. I-14 journal `remove` rename
15. I-15 `amendAssociations()` adapter and wire
16. I-16 list-taking verbs
17. I-17 permission messages
18. I-18 `POST /types` rule and setup/data docs
19. I-19 unfiltered-query docs

Tracks A–D are independent of each other apart from I-7 → I-16, so with more than one person they can run in parallel. Within a track, keep the order.
