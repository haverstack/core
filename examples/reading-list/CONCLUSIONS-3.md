# Conclusions, round 3

What to do about each item in [FINDINGS-3.md](./FINDINGS-3.md). Numbers match the findings.

Each finding was checked against the code and spec as they stand on this branch. Each decision applies a rule the library already has, or replaces two rules with one. Where a finding's suggestion would add a special case (a second `migrateAll()` mode, a warning only `migration()` emits, sugar for one verb), it is rejected, and the rule it would have bent is named instead.

| Decision                                                                                                                                    | Findings   |
| ------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| [A. A step that produces a field is typed by the target, and is final](#a-a-step-that-produces-a-field-is-typed-by-the-target-and-is-final) | 28, 27     |
| [B. A failed migration write names the record](#b-a-failed-migration-write-names-the-record)                                                | 27         |
| [C. Docs show both "can't read" channels](#c-docs-show-both-cant-read-channels)                                                             | 29, 30, 32 |
| [D. History moves onto the collection](#d-history-moves-onto-the-collection)                                                                | 35         |
| [E. Public input types take readonly arrays](#e-public-input-types-take-readonly-arrays)                                                    | 33         |
| [No change](#no-change)                                                                                                                     | 31, 34, 36 |

## A. A step that produces a field is typed by the target, and is final

**Decision:** `add(field, value)` and `derive(field, fn)` are the two steps that produce a value for the target. Both are typed by it: `field` is one of the target's top-level fields, and `value` (or `fn`'s return) is that field's write type, `ContentOf<T>[K]`. At runtime, `migration()` refuses a later step that renames, maps or drops a field an `add` or `derive` produced.

`migration()`'s third argument becomes a function that receives the steps, already typed by both handles, and returns the list. The top-level `rename`, `map`, `add`, `drop` and `derive` exports are deleted. The [prototype](#prototype-results) showed that standalone steps can't be typed by the target reliably.

```ts
migration(BookV1, Book, ({ derive }) => [
  derive('status', (c) => (c.status === 'done' ? 'finished' : c.status)),
  //                                                          ^^^^^^^^
  // TS2322: Type 'string' is not assignable to type '"want" | "reading" | "finished" | "abandoned"'.
]);
```

**Why:**

- **28 is confirmed.** `DeriveStep.derive` returns `unknown` (`migration-steps.ts`), while its input is already typed `StoredContentOf<F>` through `migration()`'s parameter. The output is the half that reaches validation. Typing it makes the compiler require a total mapping, so the record in 27 can't be produced by a typed migration.
- **One rule for both producing steps.** `add`'s value is checked at module load against the target's declaration today (`fieldOrigins()`, "set to a value the target refuses"). Typing it too means `add` and `derive` follow the same rule, instead of `derive` being typed as an exception. It also catches a misspelled target field at compile time, which today is caught only by the module-load check (finding 20's leftover).
- **Why "final".** Steps run in order, so a field produced early could be renamed or remapped later, and then its type at the end isn't the type the step was checked against. Nothing is lost by refusing that: `derive('a', …)` followed by `rename('a', 'b')` is `derive('b', …)`, and a `map` after an `add` or `derive` can be folded into it. Type and runtime then state the same rule: a produced field is written once, by the step that produces it.
- **Why a builder, and only a builder.** The steps get their types from the two handles, and the builder is where both handles are known. All five steps come from it, not just the two typed ones, so a migration has one way to name its steps. Keeping the top-level exports as well would mean two spellings, and only one of them type-checked. The list is still data: `migration()` calls the function once, and what it returns is the same frozen list `fieldOrigins()` checks and a collection reads.
- `rename`, `map` and `drop` name source fields at a point in the list, so they stay plain strings checked by `migration()`. Typing them would need the list's running state in the type, for a check that already fires when the module loads.

**Rejected:**

- **Standalone `add`/`derive` that infer the target from the array.** See the prototype: the result depended on how the callback was written.
- **Allowing `map` from free text into an enum.** `carryProblem()` refuses it because free text can hold any value, and the read side's `UnlistedValue` doesn't change that. A carried value is written by `migrateAll()`, and the target's enum would refuse it.

### Prototype results

The prototype checked both shapes against core's real `ContentOf`/`StoredContentOf` with `tsc` 5 (`strict`), using a `@1` with free-text `status` and a `@2` with an enum `status`, a required boolean `pinned` and an optional `rating`.

**Standalone steps don't work.** `derive<F, T, K>(field: K, fn: (c: F) => T[K])`, with `F` and `T` inferred from the `migration()` array they sit in, accepted a callback with a parameter that returns a conditional (`(c) => c.status === 'done' ? 'finished' : 'want'`). It rejected `(_c) => 'want'` and `() => 'want'`: TypeScript checks those before `T` is inferred, so `'want'` widens to `string`. Neither `NoInfer` on the callback's return nor a `const` type parameter changed that. Whether a correct migration compiled depended on how its callback was written, so this shape was dropped.

**The builder works.** With the handles fixed by `migration()`'s first two arguments, the steps are ordinary methods:

```ts
type Steps<F, T> = {
  rename(from: string, to: string): RenameStep;
  map(field: string, values: Readonly<Record<string, string>>): MapStep;
  drop(field: string): DropStep;
  add<K extends keyof T & string>(field: K, value: T[K]): AddStep;
  derive<K extends keyof T & string>(field: K, fn: (content: F) => T[K]): DeriveStep;
};

declare function migration<F extends ReadonlyTypeSchema, T extends ReadonlyTypeSchema>(
  from: TypeHandle<F>,
  to: TypeHandle<T>,
  steps: (s: Steps<StoredContentOf<F>, ContentOf<T>>) => readonly MigrationStep[],
): Migration<StoredContentOf<F>, StoredContentOf<T>>;
```

| Case                                                            | Result                                                                                                            |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `derive('status', (c) => cond ? 'finished' : 'want')`           | compiles                                                                                                          |
| `derive('status', () => 'want')`, `(_c) => 'want'`              | compiles                                                                                                          |
| a `switch` body; a named function; an annotated `(c: V1C) => …` | compiles                                                                                                          |
| `derive('rating', (c) => c.pages)`, optional target             | compiles (`undefined` allowed)                                                                                    |
| `(s) => [s.derive(…), s.add(…)]`, no destructuring              | compiles                                                                                                          |
| the reading list's `(c) => … : c.status`                        | TS2322, one line: `Type 'string' is not assignable to type '"want" \| "reading" \| "finished"'`                   |
| `derive('stauts', …)`                                           | TS2345, one line: `Argument of type '"stauts"' is not assignable to parameter of type '"status" \| "title" \| …'` |
| `add('pinned', 'yes')`                                          | TS2345, one line: `Argument of type 'string' is not assignable to parameter of type 'boolean'`                    |
| `derive('status', () => undefined)`, required target            | TS2322, one line                                                                                                  |
| `(c) => c.titel`                                                | TS2551, one line, ending `Did you mean 'title'?`                                                                  |

**Two details the issue must keep:**

- **The steps return the untyped step types** (`AddStep`, `DeriveStep`), and the list is `readonly MigrationStep[]`. The prototype first returned `DeriveStep<F, T, K>` and typed the list as a union over the target's fields. A misspelled field then gave a second error: five lines, printing the expanded content types. The builder's parameters already enforce everything, so the list needs no type of its own.
- **If a step's return type ever mentions `K`, wrap it in `NoInfer<K>`.** Otherwise `K` is inferred from the list's contextual type as well as from `field`, and widens to every key of the target. That is how the standalone shape got `K = "status" | "title" | … | "pinned"`.

`Migration`'s own type parameters and `migrate()` are unchanged. A hand-assembled `Migration` (no origins, every field read as derived) is unaffected.

**Actions:**

- [ ] Core: `migration(from, to, steps)` takes `(s: Steps<StoredContentOf<F>, ContentOf<T>>) => readonly MigrationStep[]` as above, calls it once, and freezes the result. Export the `Steps` type. Delete the top-level `rename`, `map`, `add`, `drop` and `derive` exports.
- [ ] Core: `fieldOrigins()` refuses a `rename`, `map` or `drop` of a field an earlier `add` or `derive` produced, naming both steps.
- [ ] Type tests: every row of the prototype table, so each error stays one line.
- [ ] Tests: each refused sequence (`derive` then `rename`, `add` then `map`, `derive` then `drop`). Move `collection.test.ts`, `stack.test.ts` and `type-handle.test.ts` off the `migration-steps.js` imports onto the builder.
- [ ] Spec, `data-model.md § Type migrations` (the example) and `§ Migration steps`: the builder, the typing rule, and the new refusal in the list `migration()` checks.
- [ ] Root `README.md` and `packages/core/README.md`: the `migration()` example.
- [ ] Reading list: `schema.ts`'s `derive` becomes total (e.g. a `switch` with a fallback), and the 27 demo writes its bad record untyped.
- [ ] Changeset: `minor` for `@haverstack/core`.

## B. A failed migration write names the record

**Decision:** Keep `migrateAll()` aborting on the first failure. The validation error from the shared migration write gets a header naming the record and both versions, and saying how to repair it:

```
Record "rec_…" could not be migrated from com.example.reading/book@1 to com.example.reading/book@2.
Repair it at book@1 and migrate again:
  status: Expected one of …
```

**Why:**

- **27 is confirmed.** `commitMigrationChecked()` throws a plain `StackValidationError` with the default "Content validation failed" header, which names no record.
- **The header mechanism already exists.** `StackValidationError` takes a header, so non-content failures can say what was validated ("Invalid arguments"). This is one more subject, set in `commitMigrationChecked()`, which `migrateAll()`, `commitMigration()` and a collection's migrate-then-patch all go through. All three then say the same thing. That matters most for the collection case: a caller whose own patch was valid gets an error about the migration, not about their patch.
- **Repair is already consistent.** A patch through `collection(Book)` migrates first, so it fails the same way, which is correct. The record is repaired at its stored version, with `client.patchContent(id, …)` or `collection(BookV1)`. Neither is a special route. The error only has to point there.

**Rejected:**

- **A report-and-continue mode.** `data-model.md § Type migrations` states that a buggy migration "is a bug to surface, not to paper over". A second mode means two behaviours and an option to choose between them. A query reports misfits because a read has to keep a UI working. A migration pass is a deliberate write, and running it again resumes where it stopped. With A, a typed migration can't produce the bad value in the first place, and what's left (foreign data, a `derive` that throws) is rare enough that stopping is the right default.
- **A structured `recordId` on `StackValidationError`.** It would give `validation` a different shape at one call site. The message isn't contract, and a startup failure is read by a person.

**Actions:**

- [ ] Core: `commitMigrationChecked()` passes the header above to `StackValidationError`. Errors from the other checks on that path (`checkContentWrite()`, the `_group` refusal) keep their own classes.
- [ ] Tests: `migrateAll()` over a record whose migration produces invalid content fails with a message naming the record and both TypeIds; earlier records stay migrated; a second run after repairing the record at its stored version completes.
- [ ] Spec, `data-model.md § Type migrations`: the `migrateAll()` bullet says the failure names the record, and that it is repaired at its stored version.
- [ ] Changeset: `patch` for `@haverstack/core`. Messages aren't contract.

## C. Docs show both "can't read" channels

**Decision:** No behaviour change for 29 or 30. The rules are principled and in the spec; the docs show the wrong one.

**29 and 30 are one rule seen twice.** A collection page reports what it can't type through two channels:

- `misfits`: records the page holds but can't type. Only an unfiltered page knows which records it holds.
- `skipped`: versions a content query couldn't reach (`older` narrowed by a `derive` or a `map` under a sort, `newer` always). Membership or order there is unknown, so they're reported as a flag on the first page.

Which channel speaks depends on the query. That is the banner dependence 30 describes. It's the honest answer: a content query can't say which newer records match. "The app is behind" is `misfits.length > 0 || page.skipped?.newer`, on any query.

**The README gets this wrong.** Its `onShelf()` filters on `shelfId` and sorts by `title`, so it is a content query, which by `§ Content queries across versions` "carries none" of misfits. Its `misfits` check can never fire. That's the gap 29 points at, and it's a docs bug, not a missing warning.

**29's practical cost comes from 27.** Narrowing lasts until `migrateAll()` runs, and the README's `install()` runs it. The reading list saw narrowed queries because 27 blocked the pass. With A and B, the remaining case is an older app still writing at `@1`, which the spec already treats as a lasting state the app decides about.

**32** is the same kind of gap. An upload is an `_attachment` record, and a manifest's requests are per family, so an app that uploads asks for `_attachment`. That follows from existing rules, but the README's manifest is the template apps copy, and it doesn't say so.

**Rejected:**

- **A warning from `migration()` when a step narrows.** Core doesn't log. Most migrations that change a field's kind use `derive`, so the warning would fire for most of them, and it would say nothing about which queries are affected. The page's `skipped` already does.
- **Listing newer-version records as misfits on a sorted page.** With no content filter, membership is known, but order isn't, so they'd belong to no page. Reporting them on the first page regardless would be a third rule.

**Actions:**

- [ ] Root `README.md` and `packages/core/README.md`: `onShelf()` checks `skipped?.newer` as well as `misfits`, with one sentence on which query reports which. The manifest example adds `{ baseId: '_attachment', actions: ['create', 'read-own'] }` with a comment that uploads are `_attachment` records.
- [ ] `derive()`'s doc comment says a filter or sort on the field it produces leaves older versions out until they're migrated, and links `docs/spec/data-model.md § Content queries across versions`.
- [ ] Spec, `apps.md § Plan, then apply`: a sentence that an app uploading files requests `_attachment`, which `planInstall()` shows as a foreign request owned by `'system'`.
- [ ] Spec, `data-model.md § Type handles`: the misfit bullets say a content query reports a newer version through `skipped.newer` instead, so the two are read together.
- [ ] Reading list: `listBooks()` exposes one "behind" flag built from both.
- [ ] Changeset: `patch` for `@haverstack/core` (its README is published).

## D. History moves onto the collection

**Decision:** `getVersions`, `getVersion` and `getJournal` join the collection, under the rules its other verbs already follow. A snapshot reads as `restoreVersion()` would bring it back: migrated in memory to the handle's version.

```ts
books.getVersion(id, 3); // CollectionVersion<BookContent> | null; throws MisfitError for a newer snapshot
books.getVersions(id); // { versions: CollectionVersion<BookContent>[]; misfits: VersionMisfit[] }
books.getJournal(id); // RecordJournalEntry[], unchanged; no content to type
```

**Why reconsider:** CONCLUSIONS-2 kept history on `StackClient` because it "spans versions by nature". But the collection already spans versions: every read migrates an older record, and `restoreVersion()` is on the collection and already decides the hard cases. A snapshot from before the record migrated into the family is "not found", and a restored older snapshot reads back migrated. History is the only part of the family's surface left untyped, and the reading list's `history()` is the only code that still goes around the collection.

**Each case maps to an existing rule:**

| Snapshot is…                   | Like                | Result                                              |
| ------------------------------ | ------------------- | --------------------------------------------------- |
| at the handle's version        | `get()`             | typed                                               |
| at an older version            | `get()`             | migrated in memory, typed                           |
| at a newer version             | `get()` / `query()` | `MisfitError` from `getVersion`, a misfit in a list |
| from before the family         | `restoreVersion()`  | `null` from `getVersion`, left out of a list        |
| of a record outside the family | every write         | `StackNotFoundError` / `null`, as `get()`           |

Version numbers are explicit, so a list with pre-family snapshots left out reads as a gap, not as a missing version.

`StackClient` keeps its untyped history for Types known only at runtime, as it keeps every other verb.

**Actions:**

- [ ] Core: the three verbs on `Collection<C>`, with `CollectionVersion<C>` (a `RecordVersion` whose `content` is `StoredContent<C>`) and a misfit shape for snapshots. Neither outer type flattens `C`.
- [ ] Tests: one per row of the table, on `Stack` and `ScopedStack`.
- [ ] Spec, `data-model.md § Type handles`: history moves from "stays on `StackClient`" to the verb list, with the table.
- [ ] Reading list: `history()` uses the collection.
- [ ] Changeset: `minor` for `@haverstack/core`.

## E. Public input types take readonly arrays

**Decision:** Every array in a public input type is `readonly`, so a caller's `as const` literal is accepted. This applies a convention core already has in places: a handle's `schema` is accepted "as written, readonly members and all".

**Why:** 33 is confirmed. `InstallRequest` is `Omit<GrantContent, 'grantee'>`, and `TypeGrant.actions` is `GrantAction[]`. A rule beats a fix for one field: `AppManifest.types`/`requests`, `AssociationEdit[]` lists, `associations` on create, and grant actions all hit the same wall. Accepting `readonly T[]` widens what's accepted and narrows nothing.

Annotating the callback, as the reading list does, is still needed when the literal is built inside `.map()`, because TypeScript doesn't contextually type a `map` callback's return from the outer array. That's a TypeScript limit and not something core can fix.

**Actions:**

- [ ] Core: audit exported option and input types for mutable array members and make them `readonly`. Where a type is shared by input and record content (`TypeGrant`, `GrantContent`), split the input type off rather than making stored content readonly as a side effect.
- [ ] Type tests: `as const` arrays accepted by `grantType()`, a manifest's `requests` and `types`, `editAssociations()` and `create()`'s `associations`.
- [ ] Changeset: `minor` for `@haverstack/core`.

## No change

- **31. Single-element edits are wordy.** One edit shape for associations and access is the consistency the round-two design paid for, and verbosity is an acceptable cost. Builders would also be a second spelling of the same edit, the kind of duplication A removes from migration steps.
- **34. `collection(Book)` loses the interface name.** Already settled in CONCLUSIONS-2: naming is the app's job, `Collection<BookContent>` on the field is how it sticks, and the README's `Library` shows it. Inference can't produce a name the app declares after the handle.
- **36. A collection can't open a version with no migration into it.** Working as designed (`§ Type handles`). A test simulating a newer build opens a second `Stack` with that build's migrations, which is also what a real newer build does.

## Order of work

1. **A** first. It changes `schema.ts` and the migration types every later test uses, and with it the reading list stops producing 27's record by accident.
2. **B**. Small and independent. Its test needs an untyped bad record, which A makes the only way to get one.
3. **E**. Mechanical, but touches many exported types, so it goes before D adds new ones.
4. **D**. New collection surface, written against E's conventions.
5. **C** last, so the README is written once against A–E.
