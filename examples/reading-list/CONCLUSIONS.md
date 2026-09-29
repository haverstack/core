# Conclusions

What to do about each item in [FINDINGS.md](./FINDINGS.md), decided after experimenting with it or discussing it. Numbers match the findings.

## Bugs and contract drift

### 1. `getVersions()` order depends on the adapter

**Decision:** `getVersions()` returns versions newest first on every adapter. `getJournal()` stays oldest first.

**Why:**

- The wire spec already says newest first (`wire-format.md`: `GET /records/:id/versions — list all versions (newest first)`), and the SQLite adapters and `APIAdapter` already do it. `MemoryAdapter` is the outlier, and the library-level spec and adapter contract never stated an order.
- The two lists are read in opposite directions. The journal is an append-only log that you tail forward from a cursor (`afterSeq`), so oldest first fits. Versions are restore points, and the most useful one is the version just before the current one, like an undo stack.
- `getVersions()` returning every version isn't something to rely on. `journal.md` notes that `versions` grows without pruning, and the journal is already paged over the wire for that reason. If `getVersions()` gets paging, newest first puts the useful end on the first page. Oldest first only works while the list is complete.
- Matching `getJournal()` buys little. Every `RecordVersion` carries its `version` number, so a caller who wants the other order can sort in one line.

**Actions:**

- [ ] State "newest first" in `docs/spec/versioning.md` (API surface) and in the `getVersions()` doc comment on `StackRecordAdapter` (`packages/core/src/types.ts`).
- [ ] Change `MemoryAdapter.getVersions()` (`packages/core/src/testing.ts`) to return newest first.
- [ ] Add an ordering test to `@haverstack/adapter-conformance`, with at least three versions so the order is actually exercised.
- [ ] Check whether `@haverstack/conformance-fixtures` pins the versions endpoint with more than one version. If it does, make sure the fixture is newest first. If it doesn't, add one.
- [ ] Remove the sort workaround in `ReadingList.history()` and update any caller or test that assumes oldest first.
- [ ] Changeset: `minor` for `@haverstack/core` (a consumer can observe `MemoryAdapter`'s order changing).

**Paging:** `getVersions()` is paged, with a `limit` and a `beforeVersion` cursor, in the same shape as `getJournal()`. It's a separate change from the ordering fix, which doesn't depend on it.

- [ ] Add `limit` and `beforeVersion` to `getVersions()` on `StackRecordAdapter`, `Stack`, `ScopedStack` and `StackClient`, as `JournalQuery` has `afterSeq` and `limit`. Omitting both reads every version, as it reads the whole journal. Implement in `MemoryAdapter`, `sqlite-shared` and `APIAdapter`.
- [ ] Wire: `GET /records/:id/versions` takes `?limit=` and `?beforeVersion=`, and `cursor` carries the next `beforeVersion` (or `null` at the end), as on the journal endpoint. `APIAdapter` follows it when no `limit` is given. Update `wire-format.md`, `versioning.md` and `@haverstack/conformance-fixtures`.
- [ ] `@haverstack/adapter-conformance`: paging walks every version exactly once, newest first.
- [ ] `ReadingList.history()` reads the first page.
- [ ] Changesets: `minor` for `@haverstack/core`, `@haverstack/adapter-api`, `@haverstack/adapter-conformance`, `@haverstack/conformance-fixtures` and `@haverstack/record-adapter-sqlite`.

### 2. Unscoped `Stack` lets you edit a tombstone. `ScopedStack` refuses.

**Decision:** Both surfaces refuse. `mutate()`, `patchContent()`, `associate()`, `dissociate()` and `restoreVersion()` on a soft-deleted record throw `StackConflictError` whether they're called on `Stack` or `ScopedStack`. The caller has to `undelete()` first. `undelete()` and `commitMigration()` stay exempt.

**Why:**

- `Stack` being owner-only decides who may act. It doesn't change the fact that a tombstone has no current state to edit. The rule is about the record's state, so it shouldn't depend on which surface the call came through.
- The wire spec already refuses with `409` regardless of scope (`wire-format.md § Records`: "Mutating a soft-deleted Record is `409`"). Unscoped `Stack` is the only path that lets the edit through.
- The check currently lives only in `ScopedStack.refuseIfDeleted()`, which is an invariant enforced in one caller instead of in the invariant layer. AGENTS.md puts invariants in `Stack` so every surface inherits them.
- Moving the check into `Stack` keeps the disclosure ordering (refuse only after the authority decision). `ScopedStack` authorizes first and only then calls into `Stack`, so a check inside `Stack` always runs after auth.
- Nothing is lost. Nothing in core mutates a tombstone internally. Editing a tombstone was never a way to scrub content, because `getVersions()` still serves the old content, and purge is the tool for that. Dropping an attachment association from a tombstone would break the attachment spec's own promise: `attachments.md` counts soft-deleted records as references so that `undelete()` "must find its attachments intact". An owner who really wants to change a deleted record can undelete, edit and delete again, and subscribers will see that round trip.

**Actions:**

- [ ] Refuse the tombstone mutations in `Stack` (`packages/core/src/stack.ts`). `patchContent()` routes through `mutate()`, so four methods need the check.
- [ ] Remove the now-redundant soft-delete refusal from `ScopedStack`. `refuseIfDeleted()` goes, and `requireUpdatable()`'s `mutating` flag is left gating only the `_grant` write fence.
- [ ] Update `docs/spec/versioning.md § Mutations are refused, not applied to a tombstone`: drop "under `ScopedStack`" and say the rule holds on both surfaces and is enforced in `Stack`.
- [ ] Add tests on unscoped `Stack` for each refused verb, plus one that `undelete()` followed by a mutation succeeds. Keep the existing `ScopedStack` tests, which pin the 404-before-409 ordering.
- [ ] Changeset: `minor` for `@haverstack/core` (calls on `Stack` that used to succeed now throw).

### 3. The spec describes a `get()` option that doesn't exist

**Decision:** Half of this is a code bug and half is a spec bug. The spec is right that `get()` takes `includeDeleted`, and the code gets that option (see [#6](#6-get-and-query-disagree-on-soft-deleted-records)). The spec is wrong that `delete()` "returns nothing", so the wording gets corrected.

**Why:** `delete()` returns `DeleteResult` (`{ referencedFileIds }`), which `attachments.md` already documents along with `deleteAndReturn()`. The reason given at `versioning.md § Version history` still holds: a purge leaves no Record behind, so `delete()` is the one mutating verb that doesn't answer with one. It answers with a report instead.

**Actions:**

- [ ] In `docs/spec/versioning.md § Version history`, replace "`delete()` is the one that returns nothing" with: `delete()` returns a `DeleteResult` rather than a Record, and `deleteAndReturn()` is the call to use when the caller needs the tombstone or the purged body.
- [ ] The same sentence's `get(id, { includeDeleted: true })` stays as written, since #6 makes it true.
- [ ] Check `docs/spec.md` ("`delete()` excepted") for the same wording.

### 4. `getAttachment()` returns different types per adapter

**Decision:** `getBlob()`, and so `getAttachment()`, returns a plain `Uint8Array` on every adapter, never a subclass such as `Buffer`. The array is also independent: changing it never changes the stored bytes, and changing the array passed to `putBlob()` afterwards never changes the stored copy.

**Why:**

- The type already says `Uint8Array`. `Buffer` only type-checks because it's a subclass, and it behaves differently in ways the type doesn't show:
  - `slice()` returns a view onto the same bytes on a `Buffer`, but copies on a `Uint8Array`. Code that slices and modifies the result is safe on one adapter and corrupts the original on the other.
  - `toString()` decodes to UTF-8 text on a `Buffer` but gives `"104,105,…"` on a `Uint8Array`, so an app can come to depend on it without noticing.
  - Equality checks and `constructor` checks can tell them apart.
- Returning a plain `Uint8Array` is what works everywhere (Node, browsers, workers). Compatibility follows from the contract rather than being the reason for it.
- `MemoryAdapter` has a related bug. It stores the array passed to `putBlob()` and returns that same object from `getBlob()`, so a caller who changes either one changes the stored blob, and the bytes stop matching their content-addressed `fileId`. Disk and S3 hand back a fresh copy on every read, so `MemoryAdapter` is the only adapter where this can happen, and tests running against it could pass on code that fails in production.

**Actions:**

- [ ] `blob-adapter-disk`: return `new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)` from `getBlob()` instead of `readFile()`'s `Buffer`. `readFile()` gives the buffer its own memory rather than a slice of Node's shared pool, so this view needs no copy.
- [ ] `MemoryAdapter` (`packages/core/src/testing.ts`): copy in `putBlob()` and in `getBlob()`.
- [ ] Add the rule to the `StackBlobAdapter.getBlob()` doc comment (`packages/core/src/types.ts`) and to `docs/spec/attachments.md`. Also check `docs/spec/adapters.md` for a blob adapter section that should state it.
- [ ] `@haverstack/adapter-conformance` (`src/blob.ts`):
  - In `getBlob returns exactly the bytes that were stored`, stop wrapping the result in `new Uint8Array(...)`, which converts a `Buffer` before the check can see it. Assert `Object.getPrototypeOf(retrieved) === Uint8Array.prototype` and compare `retrieved` directly.
  - Add a test that changing the array `getBlob()` returned leaves the stored bytes unchanged on the next read.
  - Add a test that changing the array passed to `putBlob()` afterwards leaves the stored bytes unchanged.
- [ ] Changesets: `minor` for `@haverstack/blob-adapter-disk` (the returned type changes), `minor` for `@haverstack/adapter-conformance` (stricter tests a third-party adapter could now fail), and `patch` for `@haverstack/core` (the `MemoryAdapter` copying fix).

## Ergonomic friction

### 5. Typed content stops at `create()`

**Decision:** Core derives an app's content type from its schema at compile time, and typed reads and writes go through a type handle. Two changes to content and the schema format support this: content fields are never nullable, and string fields can declare an `enum`.

#### Deriving types from the schema

Core can't contain TypeScript for an app's types, but it owns the schema format, which is small and fixed. So core ships a mapping from that format to TypeScript types, the way zod and TypeBox do. The app writes the schema once, as a literal, and the compiler derives the content type from it. There's no hand-written interface to keep in step with the schema.

```ts
const Book = typeHandle('com.example.reading/book@2', {
  title: { kind: 'string', required: true },
  status: { kind: 'string', enum: ['want', 'reading', 'finished', 'abandoned'], required: true },
  pages: { kind: 'number' },
});

type BookContent = ContentOf<typeof Book.schema>;
// { title: string; status: 'want' | 'reading' | 'finished' | 'abandoned'; pages?: number }
```

- `ContentOf<S>` gives the content type. `PatchOf<S>` gives the `contentPatch` type: every field optional, and `null` allowed only on optional fields, since a required field can be replaced but not removed.
- `typeHandle(id, schema)` is a plain value carrying the `TypeId` (`Book.id`), its family (`Book.baseId`) and the schema. `Book.baseId` is there so a call that means the whole family, like `migrateAll(Book.baseId)`, is as easy to write as one that passes `Book.id` by mistake (see [#7](#7-typeid-vs-baseid-isnt-consistent)). Because it's a value rather than a `defineType()` result, `StackClient` code can use it, which fits the setup/use split in #16. Its `const` type parameter keeps the literal types, so callers don't need `as const`.
- Typed reads take the handle, read with `presentAt: 'latest'`, and check `typeId` against the handle before narrowing. That runtime check is what makes a typed read more than a cast. A record of another Type throws, and so does one whose family has moved past the handle's version (the stale-writer case `presentAt: 'latest'` already reports).
- The derived types are a convenience layered on runtime validation, which stays the guarantee. A Type known only at runtime (loaded from a stack, or another app's) has no static shape and stays `Record<string, unknown>`.

**Prototype results:** built against core's real `FieldDef` union (scratchpad prototype, not committed).

- A compile-time check that core's `TypeSchema` fits the prototype's schema type passes, so every field kind has a mapping.
- A test schema using every kind derives exactly the expected type: nested objects, arrays of arrays, and `open` arrays and objects (`unknown[]` and `Record<string, unknown>`). The reading list's `book@2` derives `BookContent` exactly.
- These fail to compile: a typo'd patch key, `null` on a required field, a value outside the enum, an array with neither `items` nor `open`, and an unknown `kind`.
- A round trip through a real `Stack` works, and reading a book through a `Shelf` handle throws `Record … is com.example.reading/book@2, not com.example.reading/shelf@1`.
- Not checked yet: how readable compiler errors are for a subtly wrong nested schema, and editor hover output.

#### Content fields are never nullable

**Decision:** `null` means "absent" on every write path. `create()` and `commitMigration()` drop top-level fields set to `null` or `undefined` before storing, and a patch with `null` keeps removing the field, so reads never return `null`. A field with no value is left out. An app that needs "explicitly none" as distinct from "never set" says so in the schema, for example with an enum value like `'declined'`.

**Why:**

- Optional and nullable are different properties. The schema can only express optional (`required: false`). Nullability came along by accident, because validation skips `null` for any optional field. So `create({ pages: null })` stored `null` and `get()` returned it, which forced the derived type to be `pages?: number | null`.
- Core already treats `null` as absent everywhere except storage. A required field set to `null` fails with "Required field is missing", and a patch with `null` removes the field. Dropping `null` on `create()` makes core consistent with itself.
- Nullable fields can't coexist with merge-patch removal. `contentPatch` has one value, `null`, meaning "remove", so a field can't be both removable and settable to `null` through it.
- It removes an adapter difference. Given `{ u: undefined }`, SQLite drops the key but `MemoryAdapter` keeps `u` as a key with an `undefined` value, so `'u' in content` and `Object.keys()` differ between adapters. `data-model.md § Undefined values in a patch` already says an undefined field on `create()` "is simply a field the record does not have", so `MemoryAdapter` is out of line with the spec.
- `create()` returns the caller's input rather than what was stored, so its return value still shows the dropped keys. It should return the stored content.

Content inside `open` objects and arrays is opaque to core and keeps any `null`s it holds. Within declared nested objects, `null` is dropped by the same rule.

#### Adding `enum`

**Decision:** String fields can declare `enum: [...]`, a non-empty list of allowed values. `ContentOf<>` turns it into a union of string literals.

**Why:** without it, a field like `status` derives as plain `string`, and apps keep hand-writing unions (`BookStatus` in `schema.ts`), which is the drift `ContentOf<>` exists to remove. It's also the most obvious validation gap in the schema format.

**Schema drift:** removing values or adding an `enum` to an existing string field narrows what's valid, so it needs a version bump. Removing an `enum` or adding values widens, so it's additive. The schema hash sorts `enum` values, so reordering them isn't a change.

**Consequence for type handles:** because adding values is additive, an older app's typed read can receive a value its derived union excludes. The type handle work has to decide what a typed read does then: validate `enum` fields against the handle's schema and throw, or derive a wider type (e.g. `'want' | … | (string & {})`) so callers must handle unknown values.

**Actions:**

- [ ] Core: export `ContentOf<S>`, `PatchOf<S>`, `TypeHandle<S>` and `typeHandle()`. A handle carries `id`, `baseId` and `schema`. Add typed read/write overloads to `StackClient` that take a handle (`get`, `query`, `create`, `mutate`/`patchContent`). Typed reads use `presentAt: 'latest'` and check `typeId`.
- [ ] Let `defineType()` accept a handle's `id` and `schema` directly, so one literal serves both.
- [ ] Type tests in core pinning the mapping for every field kind (compile-time assertions, plus `@ts-expect-error` cases).
- [ ] Nullability: drop `null`/`undefined` fields in `Stack` on `create()` and `commitMigration()`, recursing into declared nested objects but not into `open` ones. Return the stored content from `create()`. Add conformance tests that `null` and `undefined` fields read back absent on every adapter.
- [ ] `enum`: add to the string `FieldDef` and to validation, drift detection (with the rules above) and canonical hashing. Carry it through `wire-types`, `adapter-api` and `conformance-fixtures` wherever schemas travel.
- [ ] Spec, `data-model.md`:
  - `§ Types`: `enum`, and "content fields are never null".
  - `§ Schema drift detection` and `§ Additive evolution within a version`: the enum rules.
  - `§ Undefined values in a patch`: `null`/`undefined` dropped on `create()`.
  - Where typed handles and `presentAt: 'latest'` are documented, a note that a handle names exactly one version.
- [ ] Reading list: replace `asBook`, `BookContent` and `BookStatus` with handles and `ContentOf<>`.
- [ ] Changesets: `minor` for `@haverstack/core`. Add `minor` for `wire-types`, `adapter-api` and `conformance-fixtures` if `enum` changes their shapes.

### 6. `get()` and `query()` disagree on soft-deleted records

**Decision:** `get()` hides soft-deleted records by default, as `query()` does. `get(id)` on a tombstone returns `null`. `get(id, { includeDeleted: true })` returns it, still as the tombstone projection under `ScopedStack`. This also settles half of [#3](#3-the-spec-describes-a-get-option-that-doesnt-exist).

**Why:**

- An app developer doesn't expect deleted records back without asking for them. Every app would otherwise need the `deletedAt` guard `ReadingList.getBook()` carries.
- One rule for both reads: soft-deleted records are hidden unless you pass `includeDeleted`.
- `null` rather than a throw: `get()` is the nullable read, and a tombstone is "not here" as far as normal reads are concerned.
- Any reader may pass `includeDeleted`, as on `query()`. The record's own permissions still decide whether they see it, so the flag leaks nothing.
- Writes stay explicit. `mutate()` on a tombstone still throws "soft-deleted; undelete it first" (see [#2](#2-unscoped-stack-lets-you-edit-a-tombstone-scopedstack-refuses)). Reads hide deleted records and writes explain why they're refused, which is the right split.

**Wire:** `GET /records/:id` answers `404` for a tombstone unless called with `?includeDeleted=true`. That fits the disclosure rule, because `404` already means "missing or unreadable", and a requester who can read the record can opt in to see that it's deleted.

**Risk:** core's own lookups must opt in. `ScopedStack` calls `this.stack.get(id)` in five places, including `requireVerb()`, which `undelete()`, the tombstone `409` and history reads all go through. If those get `null` back, `undelete()` breaks and a mutation on a tombstone answers `404` instead of `409`. Every internal lookup that's supposed to see tombstones has to pass `includeDeleted: true`.

**Actions:**

- [ ] Add `includeDeleted?: boolean` to `GetRecordOptions` (`packages/core/src/stack.ts`) and default `Stack.get()` and `ScopedStack.get()` to hiding tombstones.
- [ ] Audit every internal `get()` caller in `Stack` and `ScopedStack`, and pass `includeDeleted: true` wherever a tombstone is a valid target.
- [ ] Tests on both `Stack` and `ScopedStack`:
  - `get()` returns `null` for a tombstone.
  - `includeDeleted` returns it (as the tombstone projection under `ScopedStack`).
  - `undelete()` still works.
  - Mutating a tombstone is still `409`, and a stranger still gets `404`.
  - `getVersions()` and `getJournal()` still serve a deleted record's history.
- [ ] Wire: `GET /records/:id` takes `?includeDeleted=`. Update `wire-format.md` (the "served as a tombstone" paragraph under `§ Records`), `APIAdapter.get()` and `@haverstack/conformance-fixtures` together.
- [ ] Spec: state the default in `data-model.md` next to the query filter's `includeDeleted`, and in `versioning.md § Deletion` / `§ The tombstone is literal`.
- [ ] Remove the `deletedAt` guard from `ReadingList.getBook()`.
- [ ] Changesets: `minor` for `@haverstack/core`, `@haverstack/adapter-api` and `@haverstack/conformance-fixtures`.

### 7. `TypeId` vs `BaseId` isn't consistent

**Decision:** The spelling matches the meaning. An argument that means a whole type family takes a `BaseId` and refuses a `TypeId` with a message naming the family to pass instead. An argument that means one version takes a `TypeId`. Nothing accepts both. This covers `migrateAll()`, `grantType()`, `revokeType()` and `RecordFilter.baseId`. The stored grant follows the same rule: `GrantContent.typeId` becomes `baseId`, every `_grant` write refuses a versioned target, and a stored grant with one confers nothing.

**Why:**

- Accepting both means throwing the version suffix away, but it still looks meaningful to whoever reads the call. `migrateAll()` shows the problem most clearly:
  - `migrateAll()` migrates each record to the end of the registered migration chain (`latestTypeId()`), not to a version the caller names. With `1→2` and `2→3` registered, `migrateAll('…/book@2')` reads as "bring the v1 records up to v2" but moves every record to `@3`, including the ones already at `@2`. `migrateAll('…/book@1')` reads as "migrate the v1 records" but moves the `@2` records too.
  - #5 makes this more likely. `migrateAll(Book.id)` is the natural call with a handle in hand, and `Book.id` is a TypeId. If a newer version of the app has registered `2→3`, the older app's call moves every record past its own handle, and its typed reads then throw the stale-writer error. The failure shows up far from its cause.
- `grantType()` already accepts both, and the stored grant shows the cost. `grantType('comment@1', …)` stores `typeId: 'comment@1'` as given, so after the family reaches `@3`, `listTypeGrants()` shows a grant that looks pinned to v1 but covers every version. Grants written as `comment` and as `comment@1` are the same grant spelled two ways. A field named `typeId` that holds a family is the same mismatch this finding is about, so the field is renamed too.
- In `RecordFilter`, `typeId` and `baseId` really do mean different things (one version vs the family), so both keys stay. If `baseId` accepted a TypeId, `{ typeId: 'book@2' }` and `{ baseId: 'book@2' }` would differ by one key name and return different sets, the wider one including `@1` records with the old content shape. Today a TypeId under `baseId` resolves to `EMPTY_FAMILY` and returns nothing with no error, which is just as quiet.
- Refusing with a pointed message removes the class of mistakes the finding describes (passing a TypeId where a family is meant) without silently dropping a version. `BaseId` is a `string` alias, so the compiler can't catch the mix-up and the refusal has to happen at runtime.
- `grantType()` isn't the only way to write a `_grant`. The owner can `create()` or `mutate()` one on unscoped `Stack`, or send it through `POST /records`, and an adapter-level write or import skips `Stack` entirely. So the rule is enforced the way `access-control.md` enforces every rule about grant reach: refused on every write, and read as conferring nothing at evaluation.
- The #5 handle carries `baseId` next to `id`, so the right call is as easy to write as the wrong one.

**Actions:**

- [ ] `migrateAll()` (`packages/core/src/stack.ts`): refuse a versioned TypeId before looking up types, e.g. `migrateAll: "…/book@2" names one version; pass the family "…/book"`. Keep the "no registered types found" error for a well-formed baseId with no types.
- [ ] `grantType()` and `revokeType()`: rename `typeOrBaseId` to `baseId: BaseId` and refuse a versioned TypeId with the same message shape.
- [ ] `RecordFilter.baseId` (and `ChangeFilter`, which shares it): refuse a value carrying an `@version` suffix with `StackValidationError` instead of resolving it to an empty family.
- [ ] Rename `GrantContent.typeId` to `baseId`, so the stored field is named for what it holds. This touches `GrantContent` (`packages/core/src/types.ts`), the `_grant@1` schema in `Stack`'s system type definitions, and the field read in `grants.ts`.
- [ ] Refuse a bad grant target on every `_grant` write, not only in `grantType()`. `Stack.create('_grant@1', …)`, `mutate()`/`patchContent()` on a `_grant`, and `POST /records` all bypass `grantType()` today, so `checkGrantValid()` (a well-formed target, no protected system types) only holds for writes that go through the helper. Move its checks, plus "family only", into a validator that runs on every `_grant` write, next to `validateGrantee()`.
- [ ] At evaluation, a stored grant whose `baseId` carries an `@version` suffix confers nothing, following `access-control.md § Refused at the write, and again at evaluation`. `grants.ts` currently strips the suffix with `baseIdOf()`. This covers grants that reach storage without passing through `Stack`, such as adapter-level writes and imports.
- [ ] Spec:
  - `data-model.md § Types`: drop "the type-level grant verbs, which accept either" and state the rule that a family argument takes a `BaseId` only and refuses a `TypeId`.
  - `access-control.md § Type-level grants`: `grantType(baseId, …)` / `revokeType(baseId, …)`, the refusal, and the `baseId` field in the `GrantContent` block. Update `§ What a grant covers` (matching is by the stored `baseId`, and an `@n` target confers nothing) and the `revokeType()` note about grants "written against the baseId and against a versioned TypeId of the same family".
  - `access-control.md § Refused at the write, and again at evaluation`: the target checks are enforced on every `_grant` write, not only in `grantType()`.
  - Where `RecordFilter.baseId` is documented, the refusal.
- [ ] Update the `_grant@1` bodies in `@haverstack/conformance-fixtures` to carry `baseId`. Add fixtures showing that `POST /records` refuses a `_grant@1` whose `baseId` has an `@version` suffix or names a protected system type. Check `adapter-api` and `wire-types` for anything that carries `GrantContent`.
- [ ] Tests:
  - `migrateAll()`, `grantType()`, `revokeType()` and `RecordFilter.baseId` each refuse a TypeId with the helpful message.
  - `migrateAll(baseId)` with a three-version chain migrates everything to the end of the chain.
  - `Stack.create('_grant@1', …)` and `mutate()` on a `_grant` refuse a versioned or protected target.
  - A `_grant` with an `@n` target that reached storage through the adapter confers nothing.
- [ ] Reading list: pass the family to `migrateAll()` and `grantType()` (`Book.baseId` once #5 lands).
- [ ] Changesets: `minor` for `@haverstack/core` and `@haverstack/conformance-fixtures`. Add `minor` for `adapter-api` and `wire-types` if the rename changes their shapes.

### 8. Granting record-level `write` takes two calls in a fixed order

**Decision:** `grantAccess()`, `revokeAccess()`, `associate()` and `dissociate()` take an array of elements, and each call is one atomic write. Granting edit access is `grantAccess(id, [read, write])`. `write` does not imply `read` anywhere: the caller names both, and the stored set holds exactly what was named. Underneath, the adapter's `associate()`/`dissociate()` pair becomes one `amendAssociations(id, changes)` call that applies a list of changes atomically. A change has the journal's shape (see [#9](#9-you-cant-replace-one-association)).

**Why:**

- `access-control.md § Write implies read` already refuses a `write` with no `read` for the same grantee, and it checks the set the write would _produce_. A call naming both elements produces a valid set, so the array needs no new rule.
- Adding `read` automatically when only `write` is granted was rejected:
  - The revoke round trip leaves access behind. `grantAccess(write)` would add `read` quietly, and `revokeAccess(write)` removes only `write`, so the grantee keeps a `read` the owner never granted. Revoking both isn't safe either, because the grantee may have held `read` before, and the record doesn't track which elements were added implicitly.
  - The owner would then be refused on a `revokeAccess(read)` for an element they never wrote, because its `write` still stands.
  - The rule covers `grantAccess()`, the `permissions` key and `grantType()` alike. Filling in `read` in one of them makes the same element refused through the others. Filling it in for the key too means a key that replaces the whole set stores more than the caller named.
  - `grantType(['update-own'])` is satisfied by `read-own` or `read-any`. Adding one would choose a reach for the owner.
- One call is one atomic write and one journal entry. Calling the adapter once per element would give two writes and two entries, with an intermediate state between them, which is what #8 is about. So the adapter has to take a list.
- The adapter takes a list of changes that can mix adds and removes, rather than a list of additions, so #9's atomic swap needs no second contract change. The public verbs keep their current meaning: `associate()` and `grantAccess()` only add, `dissociate()` and `revokeAccess()` only remove, and `mutate()` stays the only way to replace the whole set. A journal entry already records a list of association changes, so one adapter call matches one entry.
- The array also helps outside this finding, for example sharing a record with several people in one atomic change.

**Rules for a list:**

- An empty list is refused with `StackValidationError`.
- A list naming one identity twice is refused, as the `associations` key already is (`adapters.md § Associations are keyed by identity`). So is a list that both removes and adds one identity.
- A list never mixes authority and data elements (`access-control.md § Storage unifies; the API does not`). `Stack` never builds one, and `amendAssociations()` refuses one, since `APIAdapter` couldn't send it as one request.
- An element already present (on add) or absent (on remove) is a no-op for that element, as it is for a single element today. A call where every element is a no-op returns the record without writing.
- The write-implies-read check and the `_group` at-least-one-admin check read the post-state of the whole call.

**Wire:** each surface gets one endpoint that takes a list of changes, so `APIAdapter.amendAssociations()` sends one request per call. `POST /records/:id/permissions` and `POST /records/:id/associations` take `{ "changes": [...] }` in #9's shape, and the `/delete` sub-paths go. The reshare gate on permissions and the `409` on a tombstone are unchanged.

**Actions:**

- [ ] Adapter contract (`packages/core/src/types.ts`): replace `StackRecordAdapter.associate()`/`dissociate()` with `amendAssociations(id, changes: AssociationEdit[], opts?)`, applied atomically (see #9 for `AssociationEdit`). Implement it in `MemoryAdapter`, `sqlite-shared` (one transaction, removes then adds) and `APIAdapter`, and check `adapter-local` and `record-adapter-do-sqlite` for anything that wraps the old pair.
- [ ] `Stack` and `ScopedStack`: `grantAccess()`, `revokeAccess()`, `associate()` and `dissociate()` take arrays, validate the whole list first, run the post-state checks once, and write one journal entry. Update the `StackClient` interface to match.
- [ ] Change the refusal at `packages/core/src/access.ts:139` to say what to do, e.g. "grant `read` and `write` together: `grantAccess(id, [read, write])`". Give `grantType()`'s mutate-without-read refusal the same treatment (its actions are already a list, so the message is its whole fix).
- [ ] `@haverstack/adapter-conformance`: `amendAssociations()` applies a list of adds and removes atomically, collapses on identity, refuses a list mixing authority and data elements, and never bumps `version`.
- [ ] Spec:
  - `wire-format.md § Associations` and `§ Permissions`: the `changes` bodies, and the `/delete` sub-paths removed.
  - `data-model.md § Mutations` and `§ Associations`: the verbs take lists, and the list rules above.
  - `access-control.md § Write implies read`: `grantAccess(id, [read, write])` as the way to grant both, and note that `write` never implies `read`.
  - `adapters.md`: the `amendAssociations()` contract.
- [ ] `wire-types` and `@haverstack/conformance-fixtures`: the `changes` bodies, including a fixture where `[read, write]` in one request succeeds and `write` alone is `422`.
- [ ] Tests on `Stack` and `ScopedStack`: `[read, write]` in one call succeeds with one journal entry, `write` alone is still refused, `revokeAccess(id, [read, write])` removes both, and the list rules above.
- [ ] Reading list: `letEdit` becomes one call.
- [ ] Changesets: `minor` for `@haverstack/core`, `@haverstack/adapter-api`, `@haverstack/adapter-conformance`, `@haverstack/conformance-fixtures`, `@haverstack/wire-types`, and `@haverstack/record-adapter-sqlite` (for `sqlite-shared`). Add any other adapter package that changes.

### 9. You can't replace one association

**Decision:** Two new verbs take a list of changes in the journal's shape and apply it as one atomic write: `amendAssociations(id, changes)` for data associations and `amendAccess(id, changes)` for permissions. Swapping a cover is one call:

```ts
stack.amendAssociations(bookId, [
  { op: 'remove', association: oldCover },
  { op: 'add', association: newCover },
]);
```

A change is an `add` or a `remove`. `repoint` stays something the journal records, not something a caller sends. To make the shape read correctly as input, `remove`'s `previous` field is renamed `association`, so every op names its subject `association` and `previous` appears only on `repoint`, where something was overwritten:

```ts
type AssociationChange =
  | { op: 'add'; association: Association }
  | { op: 'repoint'; association: Association; previous: Association }
  | { op: 'remove'; association: Association };

/** What a caller sends: the journal's shape without `repoint`. */
type AssociationEdit = Exclude<AssociationChange, { op: 'repoint' }>;
```

**Why:**

- It adds no new shape. The input is the type every journal entry already records and the journal endpoint already serves, so the caller, the adapter (#8's `amendAssociations()`), the wire body and the journal all share one type.
- Undo works without conversion. `journal.md § The inverse` inverts each element on its own: an `add` inverts to a `remove`, and a `remove` or `repoint` inverts to an `add`. So an inverted entry is valid input, and undoing an entry's association changes is at most two calls, one per half of the partition.
- Two verbs, because authority and data never share a call (`access-control.md § Storage unifies; the API does not`). `amendAccess()` also makes a downgrade (remove `write`, keep `read`) or replacing one grantee with another a single atomic write.
- #8's four verbs stay as shorthand for the common case. `grantAccess(id, [read, write])` reads better at the call site than two change objects.
- `repoint` is refused as input:
  - The only association field outside identity is an attachment's `attachmentRecordId`, so a `repoint` can only change which upload an attachment points to. An `add` already does that, and the journal records it as a `repoint`.
  - A caller-supplied `repoint` could only add a compare-and-set on that one field, and nobody has asked for that. It would also need its own matching rule: `remove` matches on identity and ignores annotation, but a `repoint` precondition would have to match `previous` in full or it checks nothing.
  - A cover swap is never a `repoint` anyway. Two covers are different files, so they're different identities.
- Renaming `remove`'s field reads correctly in the journal too: the entry's `association` is the element that was removed, in full, annotation included. The inverse stays one expression per element (`op === 'repoint' ? previous : association`).

**Rules:** #8's list rules apply unchanged:

- An empty list is refused.
- One identity named twice is refused, including a `remove` and an `add` of the same identity.
- Authority and data never mix in one call.
- A change that does nothing is skipped. A `remove` matches on identity, as `dissociate()` does.
- The post-state checks (write implies read, at least one `_group` admin) run once on the result of the whole list.

A `repoint` sent anyway is refused:

- **TypeScript:** `AssociationEdit` excludes it, so it doesn't compile.
- **Runtime:** `StackValidationError` at the element, e.g. `changes[0].op: "repoint" is recorded by the journal, not requested. Send { op: 'add', association }: an add naming an attachment the record already holds re-points it in place.`
- **Wire:** `400 bad_request`, since `repoint` isn't a value the endpoint defines.

**Actions:**

- [ ] Rename `remove`'s `previous` to `association` in `AssociationChange` (`packages/core/src/types.ts`) and wherever entries are built (`record-changes.ts`, `stack.ts`). Export `AssociationEdit`.
- [ ] Add `amendAssociations(id, changes)` and `amendAccess(id, changes)` to `Stack`, `ScopedStack` and `StackClient`. Each calls #8's adapter `amendAssociations()` once and writes one journal entry. `amendAccess()` carries the reshare gate and `amendAssociations()` carries the write bit, as today's verbs do. Implement #8's four verbs on top of them.
- [ ] Runtime validation of `AssociationEdit`: known `op`, no unknown keys, and the `repoint` refusal above.
- [ ] Wire: `POST /records/:id/associations` and `/permissions` take `{ "changes": [...] }` of `AssociationEdit` (the body #8 introduces). `APIAdapter` sends each call as one request.
- [ ] Spec:
  - `journal.md § The entry`: the rename, and that `repoint` is recorded, never requested.
  - `journal.md § The inverse`: the undo walk becomes one call per half, passing the inverted changes to `amendAssociations()` / `amendAccess()`.
  - `wire-format.md § Journal`: the entry example uses the renamed field.
  - `wire-format.md § Associations` and `§ Permissions`: the `changes` body and the `repoint` refusal.
  - `data-model.md § Mutations`: `amendAssociations()` / `amendAccess()` as the atomic way to add and remove in one write, beside the whole-set keys on `mutate()`.
- [ ] `@haverstack/conformance-fixtures`: update journal entries to the renamed field. Add fixtures for a remove-plus-add swap in one request and for `repoint` refused with `400`.
- [ ] `@haverstack/adapter-conformance`: update the journal assertions in `src/record.ts` that expect `{ op: 'remove', previous }`.
- [ ] Tests: a cover swap is one write and one journal entry. Inverting that entry and passing it back restores the original. A `repoint` is refused. A downgrade through `amendAccess()` from `[read, write]` to `[read]` succeeds, and removing `read` while keeping `write` is still refused.
- [ ] Reading list: `setCover` becomes one `amendAssociations()` call.
- [ ] Changesets: `minor` for `@haverstack/core`, `@haverstack/adapter-api`, `@haverstack/adapter-conformance`, `@haverstack/conformance-fixtures` and `@haverstack/wire-types`. Shared with #8 if the two land together.

### 10. Default sort direction is `desc`, and the docs don't say so

**Decision:** Follow SQL. A sort that names a field defaults to `asc`, whether the field is native or a content field, so `sort: { contentField: 'name' }` returns A→Z. A query with no sort returns `createdAt`, newest first. The spec also states every list's order in one place.

**Why:**

- `asc` is what `ORDER BY` does in SQLite, Postgres and MySQL, so most developers already expect it. Naming a sort is writing the `ORDER BY`.
- One `desc` default can't be right for both kinds of field. A content `date` like `finishedOn` reads newest first, a `name` reads A→Z, and core can't tell them apart at query time: a query can span Types, and the default doesn't consult the schema. Documenting `desc` would write down a default that's wrong for about half of content sorts.
- Per-field defaults (GitHub's REST API defaults `desc` for timestamps and `asc` otherwise) avoid one quirk but leave another: a content `date` would still default to `asc`, so the caller has to remember which kind of field they're sorting. The SQL rule has nothing to remember.
- An unsorted query is where SQL promises no order. Here it keeps `createdAt`, newest first, the order a feed-style listing reads in. This follows #1's reasoning: a list's order is chosen by how the list is read.
- The cost is one visible quirk: `sort: { field: 'createdAt' }` returns oldest first, the opposite of the unsorted default on the same field. That's what SQL does too, and the rule fits in one sentence.
- Required `direction` was rejected. Explicit, but it charges every call site for a default that SQL already settled.

**List orders**, stated together in the spec:

| Call                     | Order                                      |
| ------------------------ | ------------------------------------------ |
| `query()`, no sort       | `createdAt`, newest first                  |
| `query()` with a sort    | `direction`, default `asc`                 |
| `getVersions()`          | newest first (#1)                          |
| `getJournal()`           | oldest first                               |
| `getAttachmentRecords()` | first-recorded order (oldest first)        |
| `listTypeGrants()`       | newest first, stated rather than inherited |

**Actions:**

- [ ] `Stack.query()` / `ScopedStack.query()` normalize the sort before any adapter sees it: no sort becomes `{ field: 'createdAt', direction: 'desc' }`, and a named sort with no `direction` gets `'asc'`. Adapters then always receive an explicit direction, so the default lives in core, not in each adapter.
- [ ] Remove the `?? 'desc'` fallbacks in `MemoryAdapter` (`packages/core/src/testing.ts`) and `sqlite-shared` (`src/query.ts`). State in the `StackRecordAdapter.queryRecords()` doc comment that `sort` always arrives with a `direction`.
- [ ] `APIAdapter` always sends `?direction=` (it follows from normalization).
- [ ] `listTypeGrants()`: pass an explicit newest-first sort to `loadGrantRecords()` rather than inheriting the query default.
- [ ] Spec:
  - `data-model.md § Sorting and pagination`: the two defaults, the `createdAt` quirk, and the list-orders table (linking to `journal.md` and `attachments.md` rather than repeating their reasons).
  - `wire-format.md` (query params): `?sort=`/`?sortContent=` without `?direction=` is ascending, and a request with no sort is `createdAt` newest first. A server built on `Stack.query()` inherits both.
  - The `QuerySort` doc comment (`packages/core/src/types.ts`).
- [ ] `@haverstack/conformance-fixtures`: a fixture for a content sort with no `direction` returning ascending, and one for an unsorted query returning newest first.
- [ ] `@haverstack/adapter-conformance`: tests that an adapter honors an explicit `direction` both ways on native and content fields.
- [ ] Tests in core: the normalization, and `listTypeGrants()` order.
- [ ] Reading list: `shelves()` keeps `sort: { contentField: 'name' }` and now gets A→Z. Drop the explicit `direction: 'asc'` in `listBooks()` if it only restates the default.
- [ ] Changesets: `minor` for `@haverstack/core` (a named sort's order flips), `@haverstack/adapter-api` and `@haverstack/conformance-fixtures`. `patch` for `@haverstack/record-adapter-sqlite` (it no longer applies a default of its own, which a consumer can't observe through `Stack`).

### 11. `date` fields are strings, record timestamps are `Date` objects

**Decision:** Content keeps refusing `Date`, and the refusal says what to pass instead. Separately, content validation refuses any value that isn't plain JSON, at every depth, `open` objects and arrays included.

**Why accepting `Date` was rejected:**

- **A `Date` is a moment in time, and a `date` field often means a calendar day.** The schema has one `date` kind that takes both `2026-09-28` and a full timestamp, so core can't tell which the app meant. Converting with `toISOString()` gives UTC. `finishedOn: new Date()` at 8 pm on Sept 28 in UTC−7 stores `2026-09-29T03:00:00.000Z`, and `new Date(2026, 8, 28)` in UTC+2 stores `2026-09-27T22:00:00.000Z`. Today that write fails loudly. Accepting `Date` would turn it into a silent off-by-one-day that only appears in some time zones.
- **Reads can't return what was written.** Content is JSON, and SQLite and the wire store strings. Returning `Date` would mean converting per schema on every read, which can't be done for Types known only at runtime. A `Date` written in would come back as a string, including from `create()`, which returns the stored content under #5. #5's derived types would also need separate input and output shapes.
- **Stored formats would mix, and content filters are exact-match.** Records written with strings hold `2026-09-28`, records written with `Date` hold `2026-09-28T00:00:00.000Z`, and `filter.content: { finishedOn: '2026-09-28' }` silently skips the second kind.
- **Conversion adds failure modes.** `new Date('garbage').toISOString()` throws a `RangeError`, and a year past 9999 produces `+010000-…`, which the ISO check rejects. Every write path (`create()`, `contentPatch`, `commitMigration()`, migration functions under `migrateAll()`) would need to convert and then catch both.
- Refusing with a message that names the fix makes the app choose between a moment and a calendar day, which is the one thing core can't choose for it. It matches how #7 and #9 handle a plausible-looking wrong input.

**Why refuse non-JSON values everywhere:**

- Validation stops at an `open` object or array (`validate.ts`), and a closed `object` field accepts a `Date` because a `Date` has no own keys to check against `properties`. So a `Date`, `Map` or class instance can reach storage today.
- `MemoryAdapter` stores the value as given, and SQLite serializes it with `JSON.stringify`. A `Date` then reads back as a `Date` from one and as a string from the other, which is the same adapter drift #5 fixed for `undefined`. The drift exists today, whatever #11 decides.
- `open` says the schema doesn't describe the shape. It doesn't exempt the content from being JSON.

**The message:**

```
finishedOn: Expected an ISO 8601 date string, got a Date. Pass
date.toISOString() for a moment in time, or a "YYYY-MM-DD" string for a
calendar day.
```

Wherever validation names the type it got, a `Date` is named as `a Date` rather than `object`, so a `Date` in a `string` field gets the same hint.

**Actions:**

- [ ] `packages/core/src/validate.ts`:
  - The `date` check names a `Date` and gives the message above.
  - Every "got …" message names a `Date` as `a Date` (one helper for the type name, used at each site).
  - A JSON-value check at every depth, including inside `open` objects and arrays: only `null`, booleans, finite numbers, strings, arrays and plain objects (prototype `Object.prototype` or `null`). Anything else is a `StackValidationError` at its path. This runs after #5's `null`/`undefined` dropping, which stays the one normalization on write.
- [ ] Tests:
  - A `Date` in a `date` field is refused with the message above.
  - A `Date` in a `string` field, a closed `object` field and an `open` object is refused at its path.
  - `NaN` and `Infinity` in an `open` array are refused (`JSON.stringify` would turn them into `null`).
- [ ] Spec, `data-model.md § Types`: `date` holds a string, a `Date` is refused with guidance to choose between a moment and a calendar day, and content is JSON at every depth, `open` included.
- [ ] Changeset: `minor` for `@haverstack/core` (content an `open` field accepted before is now refused).

### 12. Unfiltered queries include system records

**Decision:** Keep returning system records. An unfiltered `query()` returns every record the caller can read, from every app, system records included. This is a documentation fix: say so in the README quick starts and next to the filter defaults in the spec.

**Why not hide system types by default:**

- **It doesn't remove the need for a type filter.** On a stack shared by several apps, an unfiltered query also returns other apps' types. The reading list would still need `filter: { typeId: BOOK }` to avoid another app's notes, so hiding system types solves only part of the surprise, and the README would still have to explain the rest.
- **Every internal caller would have to opt out**, the same risk #6 carries. The dangerous ones are `deleteAttachment()` and attachment GC (`stack.ts`), which ask whether anything still references a file with an unfiltered `query({ filter: { referencesFileId } })`. Any record can carry an attachment association, system records included, such as an avatar on an `_entity` or `_group` card. If those were hidden, a file referenced only by a system record would look unreferenced and GC would delete the bytes, with no error. Future internal queries would carry the same risk, and a missed opt-out wouldn't show in tests unless one covered a system record.
- **Tools that need everything would silently lose data.** A backup, export or sync tool paging through an unfiltered query would leave out grants, groups and entity cards, and a restore from it would lose every permission.
- **It adds a flag to carry everywhere.** `includeSystem` would have to go through `RecordFilter`, `ChangeFilter`, the wire, fixtures and every server.
- **The benefit is small.** Mainly that an untyped `filter.search` wouldn't match `_entity` names, and an app searching its own records passes its type anyway.

**Actions:**

- [ ] `data-model.md § Filter`: state that a query hides exactly three things by default, soft-deleted records (`includeDeleted`), unlisted records (`includeUnlisted`) and `_config` (always), and nothing else. So an unfiltered query returns every readable record from every app, system types included, and an app filters by `typeId`, `baseId` or `appId` to get its own.
- [ ] Root `README.md` and `packages/core/README.md` quick starts: one sentence beside the `query()` example saying the same, pointing at the type filter it already uses.
- [ ] Changeset: `patch` for `@haverstack/core`, since `packages/core/README.md` is published with the package. No code change.

## Minor

### 13. Adapters are constructed inconsistently

**Decision:** An adapter that holds a stack's identity has exactly one entry point, an async static `open(opts)`, and a private constructor. Whether `open()` may create a new stack is an option, not a separate method. Blob adapters hold no identity and keep their public constructors. `Stack.open(adapter)` stays a separate step.

| Adapter                                     | Entry point                                   | `create`                                          |
| ------------------------------------------- | --------------------------------------------- | ------------------------------------------------- |
| `LocalAdapter`, `NativeSQLiteRecordAdapter` | `open({ path, create?, ownerEntityId?, … })`  | `'never'` (default), `'ifMissing'`, `'exclusive'` |
| `DoSQLiteRecordAdapter`                     | `open(storage, { ownerEntityId, timezone? })` | none: always creates if missing                   |
| `APIAdapter`                                | `open({ url, ownerEntityId?, … })`            | none: a client never creates                      |
| `MemoryAdapter`, `IncapableMemoryAdapter`   | `open({ ownerEntityId, timezone? })`          | none: always new                                  |

`create` names what `open()` does when the store is missing or present, like `O_CREAT`/`O_EXCL`:

- `'never'`: open an existing store, fail if missing.
- `'ifMissing'`: open it if present, create it if not.
- `'exclusive'`: create it, fail if present.

`ownerEntityId` follows one rule everywhere it's accepted:

- **Required whenever `open()` may create.** The type makes it required for `'ifMissing'` and `'exclusive'`, on the DO adapter and on `MemoryAdapter`. No adapter defaults it to `''`.
- **A plain string or a lazy `() => string | Promise<string>`** on every creating path, called only when a store is actually created.
- **A plain string is checked against an existing store's owner**, in every mode and on every adapter, and a mismatch throws `OwnerMismatchError`. A lazy provider is never called just to compare.

**Why:**

- **One thing to learn.** Four adapters today use four shapes: a sync constructor, three factories, one factory with positional storage, and one factory for the API adapter. Under this rule, knowing one adapter tells you how to open the others.
- **A mode instead of methods fits every backend.** Separate `initialize()`/`open()` only make sense for files. The DO and API adapters would each support one of the three methods, and `MemoryAdapter` would have an `open()` that can't open anything. With a mode, each adapter supports exactly the modes it can honor, and the ones that can't choose drop the option.
- **The owner check stops being `LocalAdapter`'s alone.** Today only `LocalAdapter.openOrInitialize()` and `APIAdapter` (as `expectedOwnerEntityId`) check the owner. `NativeSQLiteRecordAdapter` can't, and `DoSQLiteRecordAdapter` ignores a mismatched owner without an error. That's the silent config divergence `spec.md` says `initialize()`/`open()` exist to prevent.
- **`MemoryAdapter`'s `''` default hides a mistake.** `new MemoryAdapter()` succeeds and `Stack.open()` rejects it later with `InvalidAdapterError`. A required option fails at compile time instead.
- **`Stack.open()` stays separate** because `combineAdapters()` sits between the two steps. A convenience that returns a `Stack` directly (option C in the discussion) can come later if the quick start still reads as too much ceremony.

**Actions:**

- [ ] `@haverstack/core/adapter`: export `OwnerMismatchError` (`expected`, `actual`, and a `where` string naming the path, URL or DO), outside the `StackError` taxonomy alongside `InvalidAdapterError`.
- [ ] `NativeSQLiteRecordAdapter`: replace `initialize()`/`open()` with `open({ path, create, ownerEntityId, timezone, force })`. The owner check moves here, so `LocalAdapter` inherits it. Error messages for a missing or existing file name the `create` mode to pass instead of the other method.
- [ ] `LocalAdapter`: replace `initialize()`/`open()`/`openOrInitialize()` with `open()`, passing options through. Delete `LocalAdapterOwnerMismatchError`.
- [ ] `DoSQLiteRecordAdapter`: rename `openOrInitialize()` to `open()`, and check a plain-string `ownerEntityId` against a stored config instead of ignoring it.
- [ ] `APIAdapter`: rename `expectedOwnerEntityId` to `ownerEntityId` (same meaning: asserted, never used to create) and throw `OwnerMismatchError` in place of `APIAdapterOwnerMismatchError`, which is deleted.
- [ ] `MemoryAdapter`, `IncapableMemoryAdapter` (`packages/core/src/testing.ts`): private constructor, `static async open({ ownerEntityId, timezone })` with `ownerEntityId` required. Update call sites in every package's tests and the conformance harness. The `InvalidAdapterError` test in `stack.test.ts` builds its owner-less adapter some other way.
- [ ] Tests, per adapter that accepts `create`: each mode against a missing and an existing store. Per adapter: a plain-string owner mismatch throws `OwnerMismatchError` and releases what it acquired, and a lazy provider isn't called when the store exists.
- [ ] Spec: `spec.md`'s quick start and the paragraphs after it describe `open()` and `create`. `adapters.md` gets a `## Construction` section stating the rule and the table above, and its `combineAdapters()` example and `§ Concurrency & storage ownership` stop naming `initialize()`.
- [ ] READMEs: root, `packages/core`, `packages/adapter-conformance`, and any adapter README that shows construction.
- [ ] This example: `main.ts` uses `open({ create: 'exclusive', … })` for the v1 run and `open({ path })` after.
- [ ] Changeset: `minor` for `@haverstack/core`, `@haverstack/record-adapter-sqlite`, `@haverstack/adapter-local`, `@haverstack/record-adapter-do-sqlite` and `@haverstack/adapter-api`.

### 14. `StackPermissionError: Permission denied` is the one vague message

**Decision:** Every `StackPermissionError` says what was refused, and the constructor no longer has a default message, so a new throw site can't be vague either. The error gets no structured fields. How specific a message can be depends on what the requester can already read.

**What each refusal says:**

- **Refusing a Record the requester can read** (the three sites that go through `denialFor()`: the update/delete gate, the `_group` management gate, and reshare). `disclosure.md § Which refusal a Record answers with` already allows these to be specific. They name the verb, the Record, its type, and what was missing, and they say which side lacked it when the requester is delegated:
  - `Cannot update "<id>" (<typeId>): requires update-own or update-any`
  - `Cannot delete "<id>" (<typeId>): the app acting for this entity holds no delete grant`
  - `Cannot change permissions on "<id>": only its author or the stack owner can reshare it`
  - `Cannot change group "<id>": only its admins can manage it`
- **Refusing a reference** (file-reference fields, `attachment` and `relationship` associations, `parentId` on `create()` and `mutate()`, the `fileId` of a non-owner `_attachment` create) **and `getAttachment()`**. The requester may not be able to read the target, so the message names only what the caller passed and reads the same whether the target is missing or unreadable:
  - `Cannot reference record "<id>" as parent: it does not exist or you cannot read it`
  - `Cannot reference file "<fileId>" in field "<field>": it does not exist or you cannot read it`
  - `Cannot read file "<fileId>": it does not exist or you cannot read it`

**Why:**

- **Only the default was vague.** Every other throw site already passes a specific message. The 9 bare sites are where an app is most likely to need to know why: an app that edits shared records hits the update gate first.
- **The disclosure rule already allows it for Records.** The spec's reasoning holds: a requester who can read a Record learns nothing new from being told what it lacks on it, and it only ever learns its own grants.
- **References can still say what failed.** Naming the ID the caller supplied tells them nothing they didn't already know, and "does not exist or you cannot read it" keeps the two cases indistinguishable, as `access-control.md § Reference-creation gating` requires.
- **No structured fields yet.** Fields like `action`, `recordId` or `reference` would need a new wire body field, fixtures, and the disclosure rule applied field by field. Nothing needs to branch on the reason yet: the reading list only checks `instanceof`. `code` stays the discriminator.
- **A required message is the guard.** With the default gone, a vague `new StackPermissionError()` fails to compile.

**Actions:**

- [ ] `StackPermissionError` (`packages/core/src/errors.ts`): `message` is required.
- [ ] `denialFor()` takes a message at every call site: `requireVerb()` (update or delete, whichever verb is being gated), the `_group` branch, and `requireReshareOf()`. `requireVerb()` works out whether the subject or the principal lacked the verb and says so.
- [ ] Reference gates (`requireFileRefAccess()`, `requireAssociationAccess()`, the `parentId` checks in `create()` and `mutate()`, the `_attachment` `fileId` check) and `getAttachment()`: messages in the form above.
- [ ] Tests: each denial names its verb and Record. For each reference gate, a missing target and an unreadable one produce the same message.
- [ ] Spec:
  - `disclosure.md § Which refusal a Record answers with`: a `StackPermissionError` names the verb, the Record and what was missing.
  - `access-control.md § Reference-creation gating`: a refused reference names what the caller passed, with one message for missing and unreadable.
  - `wire-format.md § Wire error body`: `message` is for humans and not part of the contract, and clients branch on `code`. So the fixtures' `'Permission denied'` bodies stay as they are.
- [ ] Changeset: `minor` for `@haverstack/core` (the constructor's signature changes and messages change). `wire-types` already passes a message on both of its paths and needs no change.

### 15. Unlisting reaches subscribers as `kind: 'deleted'`

**Decision:** Rename the `deleted` kind to `removed`. The set stays closed at four: `created`, `changed`, `removed`, `purged`. `removed` covers `delete` and `unlist`, as `deleted` does now, and `ops` still says which one happened. No behavior changes.

**Why:**

- **`kind` says what the subscriber should do with its copy, not what happened to the record.** `changed` already works this way: it means "upsert", not "you've seen this before". Under that reading `deleted` is the one misnamed value. An unlisted record hasn't been deleted, but the subscriber still has to drop it. `removed` says exactly that.
- **This is a naming fix, not a disclosure fix.** Mapping `unlist` to a removal isn't what protects the unlisted record. The `unlist` frame already carries `ops: ['unlist']` and the full, readable record with no `deletedAt`, so a subscriber can already tell it from a delete. The protection is that nothing more is announced while the record stays unlisted (`events.md § The unlisted transition`). Renaming leaks nothing new.
- **A fifth kind would reopen the trap it's meant to close.** An `unlisted` kind would let a handler written for four kinds miss it and keep a stale copy, which is exactly what the "most conservative entry" rule (`events.md § The event shape`) exists to prevent.
- **A flag would be redundant.** `record.deletedAt`, or `ops`, already tells a tombstone from an unlisted record.
- **`purged` still reads correctly beside it.** `removed` means drop your copy, and a tombstone may still exist. `purged` means nothing is left, not even a tombstone.

**Actions:**

- [ ] `ChangeKind` (`packages/core/src/types.ts`): `'deleted'` becomes `'removed'`. Update `changes.ts` (the `unlist` override and the op→kind table) and `CHANGE_KINDS` in `wire-request.ts`.
- [ ] `sqlite-shared` journal schema: the `kind` `CHECK` constraint lists `removed`.
- [ ] `adapter-conformance` and `conformance-fixtures`: expected `kind` values.
- [ ] Spec:
  - `events.md`: the kind/ops table, the "most conservative entry" paragraph, and a sentence under `§ The event shape` saying `kind` names what to do with a held copy and `ops` names why.
  - `change-feed.md`: the `?kind=` filter values.
  - `journal.md`: anywhere it names the kind. The unlisted and tombstone sections in `events.md` and `unlisted.md` should say "removed" wherever they mean the kind.
- [ ] Changesets: `minor` for `@haverstack/core`, `@haverstack/conformance-fixtures`, `@haverstack/adapter-conformance` and `@haverstack/record-adapter-sqlite` (for `sqlite-shared`). `wire-types` imports `ChangeKind` from core, so it's covered when dependents are expanded.

### 16. Setup and data access are split by type

**Decision:** The split is right and stays. This is a documentation fix, plus one spec gap it exposed: nothing says who may call `POST /types`. The rule becomes owner-acting-alone, matching `commitMigration()`. How an app that isn't the owner gets its types into a stack is a separate design item (app manifests, #359), not part of this entry.

**Why the split is right:** `defineType()`, `migrateAll()` and `grantType()` change the whole stack, not one record. `StackClient` is what `ScopedStack` implements for a possibly untrusted requester. Adding these to it would mean methods that throw for everyone but the owner, and letting `ScopedStack` define types would break the boundary it exists to hold.

**What the finding exposes:**

- **The pattern is undocumented.** Every app written against `StackClient` ends up with the reading list's shape: a data layer anyone can use and an install path only the owner can run. Nothing tells an app author this before `client.defineType` fails to exist.
- **`registerMigration()` is startup, not install.** Its registry lives in memory on each `Stack` instance (`data-model.md § Type migrations`), so it runs on every start. The reading list's `installReadingList()` mixes both, and that only works because it runs on every open.
- **`POST /types` has no access rule.** `ScopedStack` has no `defineType()`, so a server can only serve the endpoint through an unscoped `Stack`, and the spec doesn't say whom it serves. `POST /records/:id/migrate` is explicitly owner-only, and defining a type is at least as stack-wide as committing a migration.
- **A contained app can't install itself.** The README's contained-app example has the owner grant `note@1` to an app, but the app is what knows the schema, and under the rule above only the owner can define it. That gap is what #359 addresses.

**Actions:**

- [ ] Spec, `wire-format.md § Types`: `POST /types` is served to the owner acting alone and answers `403` otherwise, like `POST /records/:id/migrate`. `GET /types` stays open to any authenticated requester, since a client needs schemas to validate and render.
- [ ] Spec, `access-control.md § Type-level grants`: list defining a type beside `commitMigration()` as owner-acting-alone, with no grant that confers it.
- [ ] Spec, `data-model.md § Type migrations`: say plainly that registration runs at every startup, for every `Stack` instance, including one opened over `APIAdapter`.
- [ ] Root `README.md` and `packages/core/README.md`: a short "Writing an app" section describing the two layers: a data class that takes `StackClient`, and an owner-run install function that takes `Stack` (defining types, `migrateAll()`, grants), with migration registration at startup. Point to this example.
- [ ] This example: split `installReadingList()` into `registerReadingListMigrations(stack)` (every start) and `installReadingList(stack)` (types and `migrateAll()`).
- [ ] Follow-up: app manifests, #359.
- [ ] Changeset: `patch` for `@haverstack/core` (its README is published). No code change: an owner-only `POST /types` is a rule for servers, which `@haverstack/core/wire` already supports with `isOwnerActingAlone()`.
