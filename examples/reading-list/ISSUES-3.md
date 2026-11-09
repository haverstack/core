# Issue plan, round 3

How to turn [CONCLUSIONS-3.md](./CONCLUSIONS-3.md) into issues, and in what order to work them. Numbers like "27" mean findings in [FINDINGS-3.md](./FINDINGS-3.md), and letters (A–E) mean the decisions in CONCLUSIONS-3. Issues are numbered K-1 onwards so they can't be confused with round one's I-numbers or round two's J-numbers.

Each issue body should carry its decision, reasoning and action list from CONCLUSIONS-3, not a link to it, since this file lives on an unmerged branch. K-1's body also carries the prototype's results table, which its type tests are written from.

## Tracking issue

**Reading list API findings, round 3: tracking**

Links FINDINGS-3's verdict, lists every issue below as a sub-issue, and records the order. It also records the decisions made while CONCLUSIONS-3 was being written, which the issue bodies depend on:

- Migration steps come only from a builder that `migration()` passes, typed by both handles. The top-level `rename`, `map`, `add`, `drop` and `derive` exports are deleted. Standalone steps were prototyped and dropped: whether a correct `derive` compiled depended on how its callback was written.
- A field an `add` or `derive` produces is final: no later step renames, maps or drops it.
- `migrateAll()` keeps aborting on the first failure. There is no report-and-continue mode, and no structured `recordId` on `StackValidationError`; the message names the record.
- 29 and 30 are documented behaviour, not defects. "The app is behind" is `misfits.length > 0 || page.skipped?.newer`, on any query.
- History moves onto the collection, reversing CONCLUSIONS-2. A snapshot from before the record entered the family is left out, as `restoreVersion()` already treats it as not found.
- Where a type is both input and record content (`TypeGrant`, `GrantContent`), the input type is split off rather than making stored content readonly.
- 31, 34 and 36 get no issue.

## Merges and splits

| Decision | Becomes | Why                                                                                                                                                                                                                                                  |
| -------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A        | K-1     | One issue. The builder, the typing and the "final" refusal are one change to `migration()`, and splitting them would rewrite the same tests twice. A also owns the README's `migration()` example, since it deletes the exports the example imports. |
| B        | K-2     | One small issue: a header at one call site.                                                                                                                                                                                                          |
| E        | K-3     | One issue. It's an audit, so the issue lists the types found rather than one field.                                                                                                                                                                  |
| D        | K-4     | One issue: three verbs and two types on the collection.                                                                                                                                                                                              |
| C        | K-5     | One docs issue. Its `derive` doc comment lands on the builder's `Steps.derive`, since K-1 deletes the top-level `derive`.                                                                                                                            |

## Issues, in the recommended order

Order is by dependency first, then to minimise churn: changes that rewrite many tests go early, so later issues write their tests against the final API, and the README goes last so it's written once.

**K-1. `feat(core)!: migration steps come from a builder typed by both handles`** (A: 28, 27)
`migration(from, to, steps)` takes `(s: Steps<StoredContentOf<F>, ContentOf<T>>) => readonly MigrationStep[]`, calls it once and freezes the result. On `Steps`, `add(field, value)` and `derive(field, fn)` take a target field `K` and its write type `ContentOf<T>[K]`. `rename`, `map` and `drop` stay plain strings. The methods return the untyped step types, and the list is `readonly MigrationStep[]`, so a misspelled field is one error, not two. Any return type that mentions `K` wraps it in `NoInfer<K>`. Export `Steps`; delete the top-level step exports.
`fieldOrigins()` refuses a `rename`, `map` or `drop` of a field an earlier `add` or `derive` produced, naming both steps.
Type tests: every row of CONCLUSIONS-3's prototype table, each error asserted as one line. Tests: each refused sequence. Move `collection.test.ts`, `stack.test.ts` and `type-handle.test.ts` onto the builder.
Spec: `data-model.md § Type migrations` (the example) and `§ Migration steps` (the builder, the typing rule, the new refusal). Root `README.md` and `packages/core/README.md`: the `migration()` example. Reading list: `schema.ts`'s `derive` becomes total, and the 27 demo writes its bad record untyped.
_First because_ it rewrites every migration in core's tests and changes `schema.ts`, which every later issue's reading-list changes build on.
Packages: core. Changeset: `minor`.

**K-2. `fix(core): a failed migration write names the record`** (B: 27)
`commitMigrationChecked()` passes `StackValidationError` a header naming the record and both TypeIds, and saying to repair it at its stored version and migrate again. `migrateAll()`, `commitMigration()` and a collection's migrate-then-patch all go through it, so all three say the same thing. Errors from the other checks on that path keep their own classes. Class, code and `422` unchanged.
Tests: `migrateAll()` over a record whose migration produces invalid content fails naming the record and both TypeIds; earlier records stay migrated; a second run after repairing at the stored version completes. Spec: `data-model.md § Type migrations`, the `migrateAll()` bullet.
_After K-1_, because its test needs a bad record written untyped, which K-1 makes the only way to get one. Small and otherwise independent.
Packages: core. Changeset: `patch` (messages aren't contract).

**K-3. `feat(core): public input types take readonly arrays`** (E: 33)
Audit exported option and input types for mutable array members and make them `readonly`: at least `AppManifest.types` and `requests`, `InstallRequest.actions`, grant actions, `AssociationEdit[]` lists, and `create()`'s `associations`. Split the input type off where it's shared with record content (`TypeGrant`, `GrantContent`). The issue lists every type the audit finds.
Type tests: `as const` arrays accepted by `grantType()`, a manifest's `requests` and `types`, `editAssociations()` and `create()`'s `associations`.
_Before K-4_, so the types K-4 adds follow the convention from the start.
Packages: core. Changeset: `minor`.

**K-4. `feat(core): version history on the collection`** (D: 35)
`getVersions`, `getVersion` and `getJournal` on `Collection<C>`. `CollectionVersion<C>` is a `RecordVersion` whose `content` is `StoredContent<C>`, migrated in memory to the handle's version. Add a misfit shape for snapshots. Neither outer type flattens `C`. Each case follows an existing rule: older snapshots migrate like `get()`; newer ones are `MisfitError` from `getVersion` and misfits in a list; pre-family snapshots are `null` from `getVersion` and left out of a list, as `restoreVersion()` treats them; a record outside the family is not found. `getJournal` returns entries unchanged, with the family check. `StackClient`'s untyped history stays.
Tests: one per row of CONCLUSIONS-3's table, on `Stack` and `ScopedStack`. Spec: `data-model.md § Type handles`, history moved into the verb list with the table. Reading list: `history()` uses the collection.
_After K-3._
Packages: core. Changeset: `minor`.

**K-5. `docs: report both "can't read" channels, and uploads in a manifest`** (C: 29, 30, 32)
Root `README.md` and `packages/core/README.md`: `onShelf()` checks `skipped?.newer` as well as `misfits`, with one sentence on which query reports which; the manifest example adds `{ baseId: '_attachment', actions: ['create', 'read-own'] }` with a comment that uploads are `_attachment` records. `Steps.derive`'s doc comment says a filter or sort on the field it produces leaves older versions out until they're migrated, linking `docs/spec/data-model.md § Content queries across versions`. Spec: `apps.md § Plan, then apply` (an app that uploads requests `_attachment`, which `planInstall()` shows as a foreign request owned by `'system'`) and `data-model.md § Type handles` (the misfit bullets point to `skipped.newer` for content queries). Reading list: `listBooks()` exposes one "behind" flag built from both.
_Last_, so the READMEs are written once against K-1–K-4. The `onShelf()` check is a live docs bug, though: if K-1–K-4 will take a while, land the README half first as its own small PR.
Packages: core (README is published). Changeset: `patch`.

## Summary order

1. K-1 migration step builder
2. K-2 migration failure names the record
3. K-3 readonly input arrays
4. K-4 history on the collection
5. K-5 "can't read" channels and uploads docs

K-1 goes first. K-2 needs K-1. K-3 is independent of K-1 and K-2 and can run in parallel with them, but must land before K-4. K-5 goes last, or its README half first if the rest is slow.
