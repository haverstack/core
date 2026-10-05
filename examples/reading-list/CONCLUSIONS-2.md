# Conclusions, round 2

What to do about each item in [FINDINGS-2.md](./FINDINGS-2.md). Numbers match the findings.

Round one took each finding on its own. This round started from the whole list, because most of it traces back to three design choices in how typing was added, not to ten separate gaps. Each of the three decisions below covers several findings, and only two findings are left over as mechanical fixes.

| Decision                                                                                                                            | Findings       |
| ----------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| [A. Typed access goes through a collection](#a-typed-access-goes-through-a-collection)                                              | 18, 19, 21, 22 |
| [B. A handle carries its lineage, and migrations are typed values](#b-a-handle-carries-its-lineage-and-migrations-are-typed-values) | 20, 26         |
| [C. Records that don't fit are reported, not thrown](#c-records-that-dont-fit-are-reported-not-thrown)                              | 17, 22, 24     |
| [Mechanical fixes](#mechanical-fixes)                                                                                               | 23, 25         |

## A. Typed access goes through a collection

**Decision:** The handle becomes the receiver instead of an argument. `client.collection(Book)` returns a `Collection<C>`, typed by the handle's content `C = ContentOf<S>` (see [Prototype results](#what-changes-in-the-design)), whose methods all take and return the handle's types, each with one signature. The handle-first overloads on `StackClient` are deleted. The untyped `StackClient` is otherwise unchanged and stays the API for Types known only at runtime.

```ts
const books = client.collection(Book);

await books.create({ title: 'Dune', author: 'Frank Herbert', status: 'want' }, { appId });
await books.get(id); // BookRecord | null
await books.query({ filter: { content: { status: 'want' } }, sort: { contentField: 'title' } });
await books.patchContent(id, { status: 'reading' }); // BookRecord
await books.associate(id, [{ kind: 'tag', label: 'fantasy' }]); // BookRecord
await books.subscribe((change) => …);
```

**Why:**

- **Overloads make typing a per-verb job.** Every verb needs its own handle-first overload, so typing reaches only the verbs someone got to. That's 18: the association, access and lifecycle verbs return `StackRecord`, and the reading list re-reads through the handle to get a `BookRecord` back. A collection types every verb it has.
- **Overloads can't parameterise shared option types.** `TypedQuery` is the untyped `StackQuery` with keys `Omit`ted, so `filter.content` stays `Record<string, unknown>`. That's 19. A collection's query type is built from `S`.
- **Overloads cause the long compile errors.** With two signatures per call, every mistake is TS2769 "No overload matches this call", followed by the expanded schema once per overload. That's 21. A single signature reports the mistake directly.
- **Scope gets decided once.** Today each typed operation sets its own scope, which is how query and subscribe came to differ (24). A collection has one documented scope: the handle's whole family, read at `presentAt: 'latest'`.
- **"Not a book" becomes "not found".** In a collection, an ID that belongs to another Type is simply not in it, so `books.get(shelfId)` answers `null` (22). See [C](#c-records-that-dont-fit-are-reported-not-thrown) for records that are in the family but can't be typed.
- The shape is familiar: a Drizzle table or a Mongo collection. There's no install base, so the overloads go rather than living on beside the collection.

**What the collection offers:**

- **Reads:** `get`, `query`, `subscribe`.
- **Writes:** `create`, `mutate`, `patchContent`, `associate`, `dissociate`, `amendAssociations`, `grantAccess`, `revokeAccess`, `amendAccess`, `delete`, `undelete`, `restoreVersion`.
- **Every method that returns a record returns it the way `get` would:** migrated in memory to the latest version, then narrowed to the handle. The write already returned the record, so narrowing it locally costs no round trip. `restoreVersion` belongs here too: a restored `@1` snapshot reads back as `@2` through the registered migration, the same as any `@1` record.
- **History stays untyped:** `getVersions`, `getVersion` and `getJournal` span versions by nature, so they stay on `StackClient`.
- **Writes keep the stored-version rule.** A patch is validated against the record's stored Type, so patching a record still stored at `@1` through a `@2` collection is refused, as `typedMutate()` refuses it today. The message names the remedy (`migrateAll()`), since the record reads back as a `@2` book and the refusal is otherwise surprising.

**Typed filters and sorts (19):**

- `filter.content` keys are the handle's paths: top-level field names, plus dotted paths through declared nested objects and arrays. Below an `open` object or array, any suffix is allowed. Values are the field's type (the element type for an array, since matching is element-wise), or `null`.
- `filter.contentPresent` takes the same paths.
- `sort.contentField` takes only the top-level scalar fields. That puts `data-model.md § Sorting by a content field`'s "only top-level scalars" rule into the type.
- The type checks names against the handle's version, but matching still runs against the stored shape. A stack mid-migration can hold `@1` books whose `status` is `'done'`, which `{ status: 'finished' }` doesn't match. That's existing behaviour, already stated for sorting. The collection section of the spec should say it for filters too.

**Actions:**

- [ ] Core: add `collection(handle)` to `StackClient`, implemented once over `StackClient` (as `type-handle.ts` implements the overloads today), so `Stack` and `ScopedStack` share it. Export `Collection<C>`, parameterised by content, with filter and sort types derived from `C`. None of the outer types flattens its parameter.
- [ ] Core: delete the handle-first overloads of `get`, `query`, `create`, `mutate`, `patchContent` and `subscribe`, along with `TypedQuery`, `TypedSubscribeOptions` and `TypedChangeSet`, or reshape them as the collection's option types.
- [ ] Core: derive `ContentPathOf<C>` and `SortableFieldOf<C>` from the content type, and type the collection's `filter.content`, `filter.contentPresent` and `sort.contentField` with them.
- [ ] Type tests: every collection verb returns `CollectionRecord<C>`; a typo'd filter key, a wrong filter value type, a nested sort field and a typo'd sort field fail to compile; paths below an `open` node compile.
- [ ] Check the compile errors for 21 in the prototype: a typo'd create key, patch key and filter key should each give one short error. If the expanded schema still swamps them, look at keeping `ContentOf<S>` named in the output instead of `Simplify`-expanded.
- [ ] Spec, `data-model.md § Type handles`: rewrite around the collection, covering its scope, its verbs, and the filter-matches-stored-shape note.
- [ ] Reading list: `ReadingList` holds `books`, `shelves` and `reviews` collections; the `typed()` helper goes.
- [ ] Changeset: `minor` for `@haverstack/core`.

## B. A handle carries its lineage, and migrations are typed values

**Decision:** A handle carries the same fields `defineType()` takes: `id`, `name`, `schema` and optional `migratesFrom`. It stays plain data. A migration is a separate typed value, built from two handles and passed to `Stack.open()`. `registerMigration()` is deleted.

```ts
export const Book = typeHandle({
  id: 'com.example.reading/book@2',
  name: 'Book',
  migratesFrom: BookV1, // a handle or a TypeId; stored as the TypeId
  schema: { … },
});

export const bookV1ToV2 = migration(BookV1, Book, (c) => ({
  ...c,
  status: c.status === 'done' ? 'finished' : c.status,
})); // c: ContentOf<V1>, must return ContentOf<V2>

const stack = await Stack.open(adapter, { migrations: [bookV1ToV2] });
await stack.defineType(Book);
const manifest = { …, types: [Shelf, BookV1, Book, Review] };
```

**Why data, and not a handle that carries `migrate` too:**

- **Manifests need data.** A manifest is sent over the wire (`POST /installs`), and a plan holds a frozen copy of it. A handle with a function in it would need stripping before it went into one, or would rely on `JSON.stringify` dropping the function silently. `apps.md` already says migration functions are app code and not part of a manifest. This keeps that line clean.
- **Carrying `migrate` wouldn't remove the startup step.** The migration registry lives on each `Stack` instance. Registering when a handle is first used makes behaviour depend on call order: an untyped read or `migrateAll(Book.baseId)` before any typed use wouldn't know the chain. Fixing that needs an explicit "use this handle" call, which is `registerMigration()` under another name.
- **Handles get shared.** A handle published so others can read a family (a commons type, say) shouldn't carry one app's migration code.
- **The typing doesn't need it.** `migration(from, to, fn)` takes both handles, so `fn` is checked as `ContentOf<V1> → ContentOf<V2>` (20). A migration that forgets a new required field is a compile error.

**Why migrations are passed at open:** that's when the app can name everything it needs, and it replaces a side-effecting call the app had to remember on every start. The reading list's `registerReadingListMigrations()` and the README's "every startup" layer both go. Passing them at open also removes call order as a source of bugs, since the registry is complete before the first read.

**What this fixes:**

- **26:** `name` and `migratesFrom` are written once, on the handle, and `defineType(Book)` and manifests take the handle as-is.
- **A declared lineage with no migration is caught early.** `collection(Book)` refuses a handle whose `migratesFrom` has no migration registered, with `StackMigrationError` naming the missing pair. The check can't go in `defineType()`, because an owner applying another app's manifest defines types whose migrations live in that app's process. `collection()` runs in the app's own process, which must have them.
- `migration(from, to, fn)` refuses a `to` whose `migratesFrom` isn't `from.id`, so a migration can't be paired with the wrong handle.

**Actions:**

- [ ] Core: `typeHandle()` takes `{ id, name, schema, migratesFrom? }`, with `migratesFrom` as a handle or a `TypeId`. `TypeHandle<S>` is assignable to `DefineTypeOptions`.
- [ ] Core: add `migration(from, to, fn)`, returning a typed `Migration`. Add `migrations` to `StackOptions`. Delete `registerMigration()`. Keep the duplicate-`from` refusal at open.
- [ ] Core: `collection()` refuses a handle whose `migratesFrom` has no registered migration.
- [ ] Type tests: a migration returning content missing a required field, or with a wrong enum value, fails to compile.
- [ ] Spec: `data-model.md § Type migrations` (migrations passed at open, with `registerMigration()` gone) and `§ Type handles` (what a handle carries). In `apps.md`, the line saying migration functions are "registered at every startup with `registerMigration()`" becomes "passed to `Stack.open()`".
- [ ] Tests across core that call `registerMigration()` move to the open option.
- [ ] Reading list: handles carry `name` and `migratesFrom`; `installReadingList()` calls `defineType(Book)`; `registerReadingListMigrations()` goes.
- [ ] Changeset: `minor` for `@haverstack/core`.

## C. Records that don't fit are reported, not thrown

**Decision:** A collection never throws on a stored record just because the handle can't type it. A query reports such records beside the ones it can type, a subscription delivers the change with the reason, and a single `get()` throws a dedicated error the app can branch on. String enums also gain an `open` flag, so a schema author can say which enums may grow within a version.

### What "doesn't fit" means

A **misfit** is a record in the handle's family that the handle can't represent. There are two reasons:

- `unknown-enum`: a closed enum field holds a value the handle doesn't list. Under the closed-enum rule below, a well-behaved stack can't produce one, because adding a value to a closed enum is a version bump. It stays a reason because a typed read can't assume every writer validates, a foreign server for one.
- `newer-version`: the record is stored at a version newer than the handle's, so it can't be migrated down.

A record of another Type isn't a misfit. It isn't in the collection at all. A record stored at an older version with no migration to bridge the gap isn't a misfit either. That's a bug in the app's setup, and `presentAtLatest()` keeps throwing for it.

### Why report instead of throw (17)

- **One record can blank a list today, and enums are only one way.** `typedQuery()` reads at `presentAt: 'latest'`, and `presentAtLatest()` throws for a record newer than this app instance understands. So a newer app version writing to the same stack can blank an older app's list with a new status (17) or a new schema version. Any fix aimed only at enums leaves the second case.
- **The page and cursor survive.** The app can keep paging, and it decides what to show for the records it can't type.
- **The derived union stays exact.** Only records that fit reach `records`, so a `switch` over `status` stays exhaustive where the enum is closed.

Rejected:

- **Widen every enum to `'want' | … | (string & {})`.** Exhaustiveness goes for every enum, including ones that will never grow, typo'd comparisons compile, reads get wider than writes, and it does nothing for newer-version records. Kept as an opt-in through `open` (below).
- **Coerce unknown values to a fallback.** The UI would show something the data doesn't say.
- **Make every enum widening a version bump.** The record turns into a newer-version misfit instead. The failure moves without going away, and every new status costs a migration.

### Shapes

```ts
type Misfit = {
  id: RecordId;
  reason: 'unknown-enum' | 'newer-version';
  record: StackRecord; // untyped, as stored
  errors?: ValidationError[]; // which fields, for unknown-enum
};

books.query(…);     // { records: BookRecord[]; misfits: Misfit[]; cursor: string | null }
books.get(id);      // BookRecord | null; throws StackMisfitError for a misfit
books.subscribe(h); // change.record: BookRecord, or change.misfit: Misfit
```

- **`query()`:** misfits go in `misfits`, so a page can return fewer than `limit` records with a cursor still set. The spec should say plainly that `records.length < limit` is not the end of the results. `cursor === null` is.
- **`get()`:** a single read the app asked for by ID should be loud. `StackMisfitError` carries the same `reason` and `record`. A wrong-Type ID answers `null` (22).
- **`subscribe()`:** the collection's scope is the family, like `query()`. A change to a record stored at an older version has its `record` migrated in memory through the same registry, which works because migrations run in the app's own process. The change's own `typeId` stays the stored one, as `RecordChange.typeId` already documents. A change whose record doesn't fit carries `misfit` instead of `record`, rather than silently arriving without one. This makes typed subscriptions match typed queries (24).
- **Writes:** the result is narrowed like a `get()`. A write that produces a misfit, such as an older app patching a record that holds a newer enum value elsewhere, succeeds and then throws `StackMisfitError` carrying the stored record, so the app knows the write landed.

### Open enums (`open: true`)

```ts
status: { kind: 'string', enum: ['want', 'reading', 'finished', 'abandoned'], open: true, required: true },
// ContentOf: status: 'want' | 'reading' | 'finished' | 'abandoned' | (string & {})
```

- **Meaning:** the value list may grow within a version. Writes are still validated against the stack's current list. `open` describes what readers must expect, not what writers may store.
- **Typing:** `ContentOf` widens an open enum with `(string & {})`, so editors still suggest the listed values and readers must handle the rest. `PatchOf` stays closed, so a write can only use values the handle knows.
- **Narrowing:** an open enum never produces an `unknown-enum` misfit.
- **Drift rules:** these replace the `data-model.md § Additive evolution within a version` rule that adding values or removing an `enum` is always additive.

  | Change                        | Closed enum  | Open enum    |
  | ----------------------------- | ------------ | ------------ |
  | Add values                    | version bump | in place     |
  | Remove values                 | version bump | version bump |
  | Remove the `enum` entirely    | version bump | in place     |
  | Toggle `open` (closed → open) | version bump | n/a          |
  | Toggle `open` (open → closed) | n/a          | in place     |

  A closed enum's list is part of what the version means, which is what lets a closed-enum reader stay exhaustive. Opening one breaks that promise for existing readers, so it's a bump. Closing an open one breaks no reader.

- **Hashing:** `open` is part of the canonical schema, so toggling it is a change. Value order still isn't.
- The reading list's `status` stays closed. Its four values are the whole lifecycle, and a fifth deserves a new version.

**Actions:**

- [ ] Core: `Misfit`, `StackMisfitError` (code `misfit`), and the classification in the collection's narrowing: `typeId` mismatch outside the family means not in the collection; `newer-version` from a family record past the handle, including what `presentAtLatest()` currently throws for; `unknown-enum` from the existing enum walk.
- [ ] Core: `StackMisfitError` is raised in the app's process, but every `StackError` has a wire mapping. Give it one that is consistent with the others, and note in the spec that a server never produces it.
- [ ] Core: the collection's `query()` returns `misfits`; `subscribe()` covers the family, migrates event records in memory and carries `misfit`; `get()` and writes throw `StackMisfitError`.
- [ ] Core, schema: `open` on string `enum` in `FieldDef` and `ReadonlyFieldDef`, in schema-shape validation, in canonical hashing, and in drift detection with the table above. `ContentOf` widens open enums; `PatchOf` doesn't.
- [ ] Check `wire-types`, `adapter-api` and `conformance-fixtures` for anywhere a schema's shape is pinned. As of this writing `enum` appears only in core, so `open` likely does too.
- [ ] Tests: a query over a page with one unknown-enum record and one newer-version record returns the rest plus two misfits, and its cursor still pages; `get()` throws `StackMisfitError` with the right reason; `get()` of another Type's ID is `null`; a subscription to the family delivers a migrated `@1` change and a misfit change; open-enum values never misfit; every row of the drift table.
- [ ] Spec, `data-model.md`: `§ Type handles` (misfits, the `get`/`query`/`subscribe` behaviour, and short pages), `§ Additive evolution within a version` and `§ Schema drift detection` (the enum table), and `§ Types` (`open` on enums).
- [ ] Reading list: `listBooks()` returns misfits alongside books, and the demo shows a book written with a status the app doesn't know.
- [ ] Changeset: `minor` for `@haverstack/core`.

## Mechanical fixes

### 23. Non-content validation failures say "Content validation failed"

**Decision:** `StackValidationError`'s header says what was validated. Content keeps "Content validation failed". Arguments (`migrateAll(TypeId)`, `grantType(TypeId)`, `filter.baseId` with a version, an empty or duplicated association list) get "Invalid arguments", and each line's path names the parameter as the caller wrote it: `associations:`, not `changes:`. The class and its `422` mapping stay. Only the message changes.

**Actions:**

- [ ] Core: let `StackValidationError` take the subject for its header, and pass it at the non-content call sites. There are 25 construction sites in `packages/core/src`, so audit them all.
- [ ] Core: `associate()`/`dissociate()` and `grantAccess()`/`revokeAccess()` report list errors under their own parameter names, not the `amendAssociations()` `changes` they delegate to.
- [ ] Tests: each call site above asserts its header and path.
- [ ] Changeset: `patch` for `@haverstack/core`. Messages aren't contract; `code` is.

### 25. The root README contradicts the apps spec

**Decision:** Rewrite the README's "Writing an app" for this round anyway: collections, handles with lineage, migrations at open. Replace the "no way to install its own types yet" sentence with a pointer to `planInstall()`/`installApp()` and `docs/spec/apps.md`, with a manifest built from the handles as the example.

**Actions:**

- [ ] Root `README.md` and `packages/core/README.md`: "Writing an app" around `collection()`, `Stack.open(adapter, { migrations })` and `defineType(handle)`, plus app installs. Show naming content with an `interface` (`interface BookContent extends ContentOf<typeof Book.schema> {}`), since a `type` alias doesn't survive into hovers.
- [ ] Changeset: covered by `core`'s `minor` above (its README is published).

## Order of work

1. **Prototype A and C together on the reading list.** Done; see [Prototype results](#prototype-results). Next is moving the collection into core, taking the design changes listed there.
2. **B**, which is independent of the prototype and mostly mechanical once `migration()`'s types are settled.
3. **Open enums**, which can land any time after C.
4. **23 and 25** alongside whichever lands first.

## Prototype results

A and C were prototyped in [`src/collection.ts`](./src/collection.ts), using only the public `StackClient` API. The reading list now runs on it, [`tests/collection.test.ts`](./tests/collection.test.ts) pins its behaviour, and `pnpm start` ends with a book written by a newer build showing up as a misfit. Open enums and B were not prototyped. The prototype takes the migrations as an argument, because a `StackClient` doesn't expose the registry.

### What held up

- **The reading list got simpler.** The `typed()` re-read helper is gone. `tag`, `untag`, `linkIsbn`, `setCover`, `restore` and `revert` return `BookRecord` straight from the write. `revert` was untyped before, and a restored `@1` snapshot now reads back migrated.
- **Filters and sorts check against the schema (19).** A typo'd field, a value outside the enum, a wrong value type at a nested path, a path through a scalar, a nested sort field and a typo'd sort field all fail to compile. Paths through declared objects and arrays of objects compile, and so does any suffix below an `open` object.
- **Compile errors got short (21).** The same typo, measured with `tsc --pretty false`:

  | Mistake                     | Overload today               | Collection                                     |
  | --------------------------- | ---------------------------- | ---------------------------------------------- |
  | `stauts` in a create        | TS2769, 5 lines, 1,424 chars | TS2561, 1 line, 335 chars                      |
  | `stauts` in a patch         | TS2769, 5 lines, 1,467 chars | TS2561, 1 line, 406 chars                      |
  | `stauts` in a filter        | not caught                   | TS2561, 1 line, 437 chars                      |
  | `'wnat'` as a status filter | not caught                   | TS2322, 1 line, 143 chars                      |
  | `titel` as a sort field     | not caught                   | TS2820, 1 line, ends "Did you mean '"title"'?" |

  Each collection error ends with TypeScript's "Did you mean" suggestion.

- **Misfits keep a list working (17).** A page holding an unknown-enum record and a newer-version record returns the rest plus two misfits. Paging with `limit: 2` still reaches every record, because a short page keeps its cursor.
- **Family-wide subscriptions work (24).** A change to a `@1` record arrives with its record migrated to `@2`, while the change's own `typeId` stays `book@1`, as stored. Changes to an unknown-enum record and a `@3` record arrive with `misfit` set.
- **`get()` of another Type's ID is `null` (22),** and `delete()` refuses an ID outside the family before deleting anything.

### What changes in the design

- **Migrate to the handle's version, not the instance's latest.** `presentAt: 'latest'` migrates to the newest version this `Stack` has defined, and it throws for the whole page when one record is newer. The prototype reads records as stored and migrates each one up to the handle's version, which classifies records one at a time and doesn't depend on which versions the instance happens to know about. Core's collection should do the same rather than reuse `presentAtLatest()` as it stands.
- **Recursive path types need a depth limit.** The first version of `ContentPathOf` failed with TS2589 ("Type instantiation is excessively deep"), because the schema type is recursive. Typing paths to a depth of 6 fixes it, and deeper than that any suffix is accepted. The array branch has to count towards the depth too, not just objects. The spec caps paths at 32 segments, so 6 typed levels is a typing limit, not a query limit.
- **Type the collection by its content, not its schema.** With the schema as its type parameter, hovering an inferred `const books = collection(stack, Book)` printed `Collection<{ readonly status: { readonly kind: "string"; … } … }>`: about 25 lines of field definitions, and the same for its pages and records. Every filter and sort type can be derived from the content type alone: paths, enum unions, `open` nodes (`Record<string, unknown>` and `unknown[]`) and top-level scalars. So the prototype now has `collection(client, handle)` return `Collection<ContentOf<S>>`. The same hover is now the 8-line content shape (`status: "want" | …; title: string; …`), and `CollectionPage`, `CollectionRecord` and `CollectionQuery` print the same way. All the compile-time checks and tests pass unchanged, and the errors stay one line. The filter-typo error grew from 437 to 459 characters, because it now prints the content shape. The cost is that types can no longer tell `date` or `record-ref` from `string`. Nothing uses that distinction today; a typed date-range filter would need it, and could take the schema as a second parameter then.
- **Naming is the app's job, and an `interface` is how it sticks.** With the content as the parameter, an app that wants a name gets one: `interface BookContent extends ContentOf<typeof Book.schema> {}` makes `Collection<BookContent>` and `CollectionRecord<BookContent>` hover by name. A `type` alias doesn't stick, because `ContentOf` flattens its result. Core's part is not to defeat this: the outer types (`Collection`, `CollectionRecord`, `CollectionPage`) must never flatten their parameter. "Writing an app" should show the `interface` form. One snag: typescript-eslint's recommended `no-empty-object-type` rule rejects an empty interface, so the docs should also mention its `allowInterfaces: 'with-single-extends'` option. The reading list uses an inline disable instead.
- **Keep internal aliases out of what gets printed.** Typing `contentField` with the named alias `SortableFieldOf<S>` made its error print the alias and its argument. Spelling the type out inline prints the field names. Likewise, `NonNullable<C[K]>` leaked into filter errors as `NonNullable<"want" | …>`, and `Required<C>[K]` doesn't.
- **Content-free writes to a record outside the family can't be stopped without a round trip.** Content writes already read first (the stored-version check), and so does `delete()`. But `associate()` and the other content-free verbs only learn the Type from the record the write returns. The prototype throws "…not in the book collection. The write was applied." Checking first would bring back the extra read that 18 is about. A better fix is in core: a write precondition, `ifBaseId`, checked by `Stack` the way `ifVersion` is, which refuses before writing and costs nothing.

### Found along the way

- **A typed `subscribe()` types a tombstone as content today.** Under `ScopedStack`, a `removed` change carries the tombstone projection, `content: {}` (`versioning.md § The tombstone is literal`). Today's typed `subscribe()` narrows it, so a handler receives a `BookRecord` with no `title`, `author` or `status`. Unscoped `Stack` sends the full content instead. The collection never types a record with `deletedAt` set, so it behaves the same through both surfaces. This bug is independent of the redesign and goes away with the overloads.
- **A patch to a record still stored at `@1` reads oddly.** The collection's reads show it as a `@2` book, and then a patch is refused. The message now names `migrateAll()`, but only the owner can run that. An installed app may call `commitMigration()` within its own families, so a collection could commit the migration and then patch. That would make the write two journal entries. Left open.

### Open questions for core

1. Should writes get an `ifBaseId` precondition, so content-free collection writes need no prior read?
2. Should a collection migrate-then-patch a record stored at an older version when the caller may commit migrations?
