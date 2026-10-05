# Issue plan, round 2

How to turn [CONCLUSIONS-2.md](./CONCLUSIONS-2.md) into issues, and in what order to work them. Numbers like "17" mean findings in [FINDINGS-2.md](./FINDINGS-2.md), and letters (A, B, C) mean the decisions in CONCLUSIONS-2. Issues are numbered J-1 onwards so they can't be confused with round one's I-numbers.

Each issue body should carry its decision, reasoning and action list from CONCLUSIONS-2, not a link to it, since this file lives on an unmerged branch.

## Tracking issue

**Reading list API findings, round 2: tracking**

Links FINDINGS-2's verdict, lists every issue below as a sub-issue, and records the order. It also records the decisions made while CONCLUSIONS-2 was being written, which the issue bodies depend on:

- The collection is typed by content (`Collection<ContentOf<S>>`), not by schema, and its outer types never flatten their parameter.
- A collection write outside the family is refused as not found, through an internal expectation `Stack` checks against the read it already makes. There is no public `ifBaseId`.
- A patch to a record stored at an older version commits the migration as its own write first, when the caller may migrate.
- `MisfitError` sits outside the `StackError` hierarchy, because it has no wire representation.

## Merges and splits

| Decision                 | Becomes         | Why                                                                                                                                                                                                                                   |
| ------------------------ | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A and C                  | J-3, J-4, J-5   | A's collection and C's misfits are one piece of code: the collection's narrowing is where misfits are classified. Split by layer instead: the write expectation in `Stack`, the collection's runtime behaviour, and its filter types. |
| C, open enums            | J-6             | A schema-format change with its own drift rules and hashing. It only needs the collection's narrowing to exist.                                                                                                                       |
| B                        | J-2             | One issue. It reshapes the handle, which `@haverstack/commons` wraps today.                                                                                                                                                           |
| B, the lineage check     | folded into J-4 | `collection()` refuses a handle whose `migratesFrom` has no registered migration, and `collection()` doesn't exist until J-4.                                                                                                         |
| 25 and the naming advice | J-7             | Both are "Writing an app". Written once, last.                                                                                                                                                                                        |

The tombstone bug found during the prototype (today's typed `subscribe()` types a `ScopedStack` tombstone as content) has no issue of its own: J-4 deletes the code it lives in. If it should be fixed before J-4 lands, it's a small standalone `fix(core)`: skip narrowing when the change's record has `deletedAt` set.

## Issues, in the recommended order

Order is by dependency first, then to minimise churn: changes that rewrite many tests go early, so later issues write their tests against the final API, and the README goes last so it's written once.

**J-1. `fix(core): validation errors name what was validated`** (23)
`StackValidationError`'s header says "Content validation failed" only for content, and "Invalid arguments" for argument checks: `migrateAll(TypeId)`, `grantType(TypeId)`, a versioned `filter.baseId`, an empty or duplicated association list. Each line's path names the parameter as the caller wrote it (`associations:`, not `changes:`). Audit all 25 construction sites in `packages/core/src`. Class, code and `422` unchanged.
_First because_ it changes expected messages in tests across core. It's small and independent, so it lands before anything that adds new validation tests.
Packages: core. Changeset: `patch`.

**J-2. `feat(core)!: handles carry their lineage; typed migrations are passed at open`** (B: 20, 26)
`typeHandle({ id, name, schema, migratesFrom? })`, with `migratesFrom` as a handle or `TypeId` and the handle assignable to `DefineTypeOptions`. `migration(from, to, fn)` returns a typed `Migration` and refuses a `to` whose `migratesFrom` isn't `from.id`. `StackOptions.migrations` replaces `registerMigration()`, which is deleted. Type tests for migration functions. Spec: `data-model.md § Type migrations` and `§ Type handles`, and the `apps.md` line about registration.
`@haverstack/commons` drops its `CommonsType` wrapper (a handle plus `name`), since a handle now carries `name`.
_Early because_ it rewrites every test that registers a migration (`stack.test.ts`, `change-events.test.ts`, `install.test.ts`, `type-handle.test.ts`) and every `typeHandle()` call. J-4's tests are then written against the final handle and open options.
Packages: core, commons. Changeset: `minor` for both.

**J-3. `feat(core): Stack checks a collection's write expectation`** (A, the write fence)
A module-private symbol key on the write verbs' options carries a family and, for content writes, an exact `typeId`. `Stack` checks it against the record it already reads before every write. A family mismatch is refused with `StackNotFoundError`. A version mismatch on a content write is refused with an internal error that carries the stored record. `ScopedStack` passes the key through. Nothing on the wire changes, since a record's family never changes.
Tests (importing the symbol from its module): a mismatched family is refused before writing on every write verb, on both surfaces, with journal and version unchanged; a version mismatch carries the stored record; the check adds no adapter reads.
_Before J-4_ so the collection lands without the prototype's extra reads. It has no public surface of its own, so it's safe to merge ahead of its consumer.
Packages: core. Changeset: `patch` (not observable).

**J-4. `feat(core)!: typed access through collections, with misfits reported`** (A and C: 17, 18, 21, 22, 24)
`client.collection(handle)` returns `Collection<ContentOf<S>>`, implemented once over the public verbs plus J-3's expectation and the `Stack`'s registry.

- Reads migrate each record in memory to the handle's version, one at a time, not through `presentAtLatest()`.
- `query()` returns `{ records, misfits, cursor }`; `get()` answers `null` outside the family and throws `MisfitError` for a misfit; `subscribe()` covers the family, migrates event records, never types a tombstone, and carries `misfit`.
- Every write verb returns `CollectionRecord<C>`. A content write to an older stored version migrates then patches, fenced as CONCLUSIONS-2 describes; a caller who may not migrate is refused with nothing written. A content write to a newer-version record is refused with `MisfitError`.
- `collection()` refuses a handle whose `migratesFrom` has no registered migration (from B).
- `Misfit` and `MisfitError`, outside the `StackError` hierarchy, added to `wire-format.md § The taxonomy root`.
- Delete the handle-first overloads and `TypedQuery`, `TypedSubscribeOptions`, `TypedChangeSet`, along with the overload helpers in `type-handle.ts` (`narrowRecord`, `typedSubscribe` and the rest).
- `filter.content` and `sort.contentField` keep their untyped shapes here; J-5 types them.
- Port `examples/reading-list/tests/collection.test.ts` into core's tests, and move the reading list onto core's collection, deleting `src/collection.ts`.
- Spec: `data-model.md § Type handles` rewritten around the collection, and the `§ Type migrations` sentence about migrate-then-patch.

_After J-2 and J-3._
Packages: core. Changeset: `minor`.

**J-5. `feat(core): collection filters and sorts are checked against the content type`** (A: 19)
`ContentPathOf<C>` and `SortableFieldOf<C>`, derived from the content type and typed to a depth of 6. Type the collection's `filter.content`, `filter.contentPresent` and `sort.contentField` with them, spelling out inline anything that appears in an error. Type tests from the prototype: a typo'd key, a wrong value type, a path through a scalar, a nested or typo'd sort field fail; paths below an `open` node compile. The spec notes that the type checks names against the handle's version while matching runs on the stored shape.
_After J-4._ Separate because it's pure types with its own review concerns (recursion limits, error readability).
Packages: core. Changeset: `minor`.

**J-6. `feat(core): string enums can be declared open`** (C, open enums)
`open: true` on a string `enum`: `FieldDef`/`ReadonlyFieldDef`, schema-shape validation, canonical hashing, and drift detection with the closed/open table. `ContentOf` widens an open enum with `(string & {})`; the patch type stays closed; an open enum never produces an `unknown-enum` misfit. Check `wire-types`, `adapter-api` and `conformance-fixtures` for pinned schema shapes. Spec: `data-model.md § Types`, `§ Additive evolution within a version`, `§ Schema drift detection`.
_After J-4_, which classifies misfits. Independent of J-5, though J-5's filter value types should be checked against an open enum when both have landed.
Packages: core, plus any of the three above that pin schema shapes. Changeset: `minor` for each package changed.

**J-7. `docs: Writing an app with collections, typed migrations and installs`** (25)
Root `README.md` and `packages/core/README.md`: "Writing an app" around `collection()`, `Stack.open(adapter, { migrations })` and `defineType(handle)`. Replace "has no way to install its own types yet" with app installs (`planInstall()`/`installApp()`, `docs/spec/apps.md`), using a manifest built from handles. Show naming content with an `interface`, and mention typescript-eslint's `allowInterfaces: 'with-single-extends'` for `no-empty-object-type`.
_Last_, so the READMEs are written once against J-2, J-4 and J-5.
Packages: core (README is published). Changeset: `patch`.

## Summary order

1. J-1 validation error headers
2. J-2 handle lineage and typed migrations at open
3. J-3 write expectation in `Stack`
4. J-4 collections and misfits
5. J-5 typed filters and sorts
6. J-6 open enums
7. J-7 "Writing an app" docs

J-1 is independent of everything. J-2 and J-3 are independent of each other and can run in parallel; both must land before J-4. J-5 and J-6 can run in parallel after J-4. J-7 goes last.
