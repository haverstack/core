# API ergonomics findings

What building the reading list surfaced about `@haverstack/core`, ordered by how much each one costs an app author. Each item says where it shows up in this example.

## Verdict

The API holds together. Verbs are named consistently, every mutation returns the record it wrote, `RecordFilter` works for both `query()` and `subscribe()`, and error messages say what went wrong and how to fix it (the schema-drift and missing-migration messages are especially good). Optimistic concurrency, lazy migration and relationship queries all took about as much code as you'd hope.

The friction comes from a few places where the same idea behaves differently depending on which door you use: `Stack` vs `ScopedStack`, `MemoryAdapter` vs SQLite, `get()` vs `query()`, and `TypeId` vs `BaseId`.

## Bugs and contract drift

1. **`getVersions()` order depends on the adapter.** `MemoryAdapter` returns oldest first, the SQLite adapters (`sqlite-shared/src/record-logic.ts`) newest first, and neither the adapter contract nor the spec says which is right. So code tested against `MemoryAdapter` can behave differently in production. `getJournal()` is documented oldest first. `ReadingList.history()` sorts to work around it, and the test suite runs against both adapters to catch this kind of drift.
2. **Unscoped `Stack` lets you edit a tombstone. `ScopedStack` refuses.** `stack.patchContent(deletedId, …)` succeeds and bumps the version on a deleted record. `stack.asEntity(owner).patchContent(deletedId, …)` throws `StackConflictError`. Same person, same call, opposite outcomes. The spec (`versioning.md § Mutations are refused, not applied to a tombstone`) only covers the scoped side.
3. **The spec describes a `get()` option that doesn't exist.** `versioning.md` says a tombstone "is read back with `get(id, { includeDeleted: true })`", but `GetRecordOptions` only has `presentAt`, and `get()` returns deleted records unconditionally. The same paragraph says `delete()` "returns nothing", but it returns `DeleteResult`.
4. **`getAttachment()` returns different types per adapter.** Disk returns a `Buffer`, memory returns a `Uint8Array`. Both satisfy the type, but `toEqual` in tests and anything that checks `constructor` can tell them apart.

## Ergonomic friction

5. **Typed content stops at `create()`.** `create<T>()` returns `content: T`, but `T` isn't checked against the schema, and `get`, `query`, `mutate`, `patchContent` and `subscribe` all return `Record<string, unknown>`. Each read site casts (`asBook` in `reading-list.ts`), and a typo in a patch key is only caught at runtime. The fix: let `defineType` return a typed handle that carries the content type through reads (or a `get<T>`/`query<T>` generic), even if it's unchecked.
6. **`get()` and `query()` disagree on soft-deleted records.** `query()` hides them by default. `get()` returns them with `deletedAt` set, and there is no option to change that. `ReadingList.getBook()` has to check `deletedAt` itself, and every app will need the same guard.
7. **`TypeId` vs `BaseId` isn't consistent.** `grantType()` takes either. `migrateAll()` takes only a baseId and rejects a TypeId with "no registered types found for baseId `…@2`". `RecordFilter` has separate `typeId` and `baseId` keys. Accepting both everywhere a family is meant (as `grantType` does) would remove a whole class of mistakes.
8. **Granting record-level `write` takes two calls in a fixed order.** `grantAccess(id, write)` is refused unless the same grantee already holds `read`, so the caller has to call `grantAccess(read)` first (see `letEdit`). The refusal message explains the reasoning but doesn't say what to do. Options: have `write` imply `read` when granted, or accept an array.
9. **You can't replace one association.** `associate()` adds and `mutate({ associations })` replaces the whole set, tags included. Swapping a cover is `dissociate` + `associate`: two writes, not atomic, and two journal entries (`setCover`).
10. **Default sort direction is `desc`, and the docs don't say so.** `sort: { contentField: 'name' }` returns Z→A. Neither the `QuerySort` type docs nor `data-model.md` states the default. `shelves()` in the demo hits this.
11. **`date` fields are strings, record timestamps are `Date` objects.** `finishedOn: new Date()` fails validation ("Expected ISO 8601 date string, got object"), while `createdAt` and `updatedAt` come back as `Date`. The rule is defensible (content is JSON), but it's a trap. Accepting a `Date` on write and normalizing it would remove the trap.
12. **Unfiltered queries include system records.** `query()` with no filter returns `_entity@1` next to app records, so apps always need a type filter. That's probably right, but it's worth documenting in the README quick start.

## Minor

13. **Adapters are constructed inconsistently.** `new MemoryAdapter({ ownerEntityId })` versus `LocalAdapter.initialize/open/openOrInitialize(...)`, and both then need `Stack.open(adapter)`.
14. **`StackPermissionError: Permission denied` is the one vague message.** It doesn't name the action or type, even though `disclosure.md` says a refusal that only reaches a requester who can already read the record "is free to be specific".
15. **Unlisting reaches subscribers as `kind: 'deleted'`.** This is documented and makes sense ("drop your copy"), but a handler that treats `deleted` as a real deletion will get it wrong. An `ops` check is needed to tell them apart.
16. **Setup and data access are split by type.** `defineType`, `registerMigration`, `migrateAll` and `grantType` exist only on `Stack`, not `StackClient`. That's correct, but it means an app layer written against `StackClient` (as recommended) needs a separate owner-only install path (`installReadingList`, `shareLibraryWith`).
