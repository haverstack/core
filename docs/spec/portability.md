# Portability

**A stack can leave its host whole.** Every Record, soft-deleted and unlisted ones included, keeps its authorship, its version history and its journal, and every Type and attachment comes with it. Identity moves with the stack and the address does not: the new host serves the same owner DID, which a client confirms with `APIAdapter`'s `ownerEntityId` option ([Wire format § Identity is trusted on transport](./wire-format.md#identity-is-trusted-on-transport)). References to the old `stackUrl`, a Group's or a relationship target's, are updated by hand.

## Copying a stack

```ts
import { copyStack } from '@haverstack/core/adapter';

const target = await copyStack(from, (seed) => createStore(seed));

type StoreSeed = { config: StackRecord; history: RecordHistory };
```

**One primitive carries export, import and every move between storage engines.** `copyStack()` reads a whole stack from one `StackAdapter` and writes it into a new store, which it asks `create` to make from the source's `_config` record and returns open. Which source it is given, and what kind of store `create` makes, is the only difference between exporting to [the portable format](#the-portable-format), importing from it, and moving a stack from one SQLite engine to another. No adapter has a format-conversion method of its own, so N adapters need N implementations of the [write below](#writing-history), not one converter per pair of formats.

What it carries is everything the source holds:

- **Every Type**, through `listTypes()` and `saveType()`.
- **Every Record**, soft-deleted and unlisted ones included, each with every version snapshot and every journal entry, through [`importRecord()`](#writing-history). `_config` is among them: no query reaches it, so it is read by id, and with its history it is the seed `create` makes the target from ([Adapters § Construction](./adapters.md#construction)). The target's identity is therefore what the source's `_config` holds now, whatever its adapter read when it was opened.
- **Every blob**, through `listBlobs()`, which both ends of a copy must have.

**Each is read as the store enumerates it**, never by what a Record says, so nothing is filtered on the way: what is garbage is the target's own [collection](./attachments.md#garbage-collection) to decide, run when its owner chooses. Nothing a purge destroyed is carried, because the source no longer holds it.

**It is a full-trust operation, like any direct adapter access.** It writes authorship and history as recorded, which no write through `Stack` may: a scoped create is stamped with its requester, and nothing outside a write appends a snapshot or a journal entry. It takes adapters rather than stacks because those are where that trust already lives ([Adapters § Concurrency & storage ownership](./adapters.md#concurrency--storage-ownership)). It emits no [change events](./events.md) and appends no journal entry: it reproduces changes that already happened, each of which was announced and journaled when it did.

**The target is a store as its adapter creates one.** `create` receives that seed, as any new store is created from one, and what it returns is checked as `open()` checks a store: its owner must be the seed's, or the copy throws `OwnerMismatchError`, as `open()` does. The store must also hold nothing else yet — no other Record, no Type, no blob — on an adapter with `importRecord()` and `listBlobs()`. Anything else is a mistake in `create`, refused with `InvalidAdapterError` before anything is written; a store `Stack.open()` has already opened holds the [system Types](./data-model.md#system-types), so it is refused too.

**The source is not written during the copy.** Records are read a page at a time and each one's history separately, so a write landing partway through yields a target matching no moment of the source. Nothing enforces this: a local source's only writer is the process that owns it, which is the one copying.

**It is not atomic, and the target is the caller's.** Whatever `create` makes belongs to whoever passed `create`: on success it comes back open, theirs to close; on a failure part-way, the refusal included, `copyStack()` closes it, holding the only handle, and the caller removes it, having chosen where it lives. The copy is then run again into a new store, never resumed.

**Both ends list everything they hold.** The source needs `listBlobs()` to be read in full, and the target needs it to be checked empty and to be read in full by a later copy in turn, so a copy never lands a stack where it cannot be copied out again. A source without it is refused with `InvalidAdapterError` before `create` is called. Every blob adapter has it. `APIAdapter` does not, because the wire has no endpoint that lists blobs, so a stack behind one cannot yet be copied out through it.

## Writing history

```ts
importRecord?(record: StackRecord, history: RecordHistory): Promise<StackRecord>;

type RecordHistory = {
  versions: RecordVersion[];
  journal: RecordJournalEntry[];
};
```

`StackRecordAdapter.importRecord()` is `createRecord()` for a Record that already has a past, and the adapter contract's only write of a whole history. It writes the Record exactly as given — `version`, `createdAt`, `updatedAt`, `createdBy`, `updatedBy`, `deletedAt`, `unlistedAt`, its associations and its permissions — beside each version snapshot and each journal entry as recorded, `seq` and `at` included.

- **One atomic write**, under [the rule every mutating record method follows](./adapters.md#interface-split): a refused import leaves no row behind.
- **It answers with the Record it wrote**, as `createRecord()` does, and throws `StackConflictError` when `record.id` exists, as `createRecord()` throws.
- **It appends no journal entry of its own.** The entries it is handed are the log.
- **Writes after it continue the history it wrote.** The next bump snapshots the version the import left and moves past it, and the next entry's `seq` is [allocated from the log's maximum](./journal.md#ordering) as always.

**It is handed history a Record can have**, as every adapter method is held only to what its caller produces ([Adapters § Interface split](./adapters.md#interface-split)): every snapshot's `version` is below `record.version` — one at the record's own version is [an orphan](./versioning.md#snapshot-atomicity) — and the entries' `seq` values run [dense from 1](./journal.md#ordering), as every log's do. What an adapter does with anything else is unspecified.

`RecordHistory` is two sets, snapshots keyed by `version` and entries by `seq`: whatever order `getVersions()` and `getJournal()` read them out in, an adapter writes them by key.

**Optional, and every local adapter implements it.** It is optional only so `APIAdapter` can leave it out, as [`queryReadable()`](./adapters.md#querying-within-a-reach) is. A server is the only writer of its own durable tiers ([Versioning § Snapshot atomicity](./versioning.md#snapshot-atomicity)), and the wire carries no endpoint writing either one, so a stack behind an `APIAdapter` cannot be copied into. The [conformance suite](./adapters.md#conformance) holds an adapter declaring it to every rule above, and `runCopyConformance()` holds a full adapter to both halves of a copy: a stack with a past, written into one store it creates and copied into a second, arrives unchanged.

## The portable format

**An export is a `LocalAdapter` store: a SQLite database, with an `attachments/` directory beside it.** It is a working stack, not an archive to unpack — `Stack.open()` reads it as it reads any local stack.

```ts
const portable = (path: string) => (seed: StoreSeed) => LocalAdapter.open({ path, seed });

// Export: the host's stack, into a new portable store.
const exported = await copyStack(host, portable('./my-stack.db'));
await exported.close();

// Import: the portable store, into a store created however the new host creates one.
const exportedStack = await LocalAdapter.open({ path: './my-stack.db' });
await copyStack(exportedStack, createHostStore);
```

The layout is specified here so an export stays readable without the tool that wrote it, and a change to it changes this section in the same change; a test compares the tables below with the schema the SQLite adapters create. **Every SQLite store names its layout** in the one row of its `format` table, `id` `1`: `version` is `1` for the layout below. A change to the layout bumps it. The row is written in the same transaction as the tables and `_config`, and an adapter opening a store refuses one in another layout before writing to it, by the rules in [Adapters § Construction](./adapters.md#construction). The row is the store's own: a copy writes its target in the target's layout, which is how a stack moves to a newer one.

**`attachments/<fileId>`** holds a blob's bytes, named by the [64-character lowercase hex SHA-256](./attachments.md) of its contents.

**The database** holds its `format`, six tables that are sources of truth, and two that are [derived](./adapters.md#sqlite-backed-adapters):

| Table           | One row per                              | Key                                                                                                   |
| --------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `format`        | the store's layout version, one row only | `id`                                                                                                  |
| `records`       | Record, `_config` included               | `id`                                                                                                  |
| `associations`  | data association                         | `record_id`, `kind`, `label`, `file_id`, `related_scope`, `related_id`, `related_ns`, `related_stack` |
| `permissions`   | permission element                       | `record_id`, `kind`, `label`, `grantee_kind`, `grantee_id`, `role`                                    |
| `versions`      | version snapshot                         | `record_id`, `version`                                                                                |
| `journal`       | journal entry                            | `record_id`, `seq`                                                                                    |
| `types`         | Type                                     | `id`                                                                                                  |
| `content_index` | derived: top-level scalar field          | `record_id`, `field`                                                                                  |
| `records_fts`   | derived: full-text index entry           | `rowid` of the `records` row                                                                          |

Their columns follow four encoding rules:

- **Times are integers**, milliseconds since the Unix epoch.
- **Structured values are JSON text**: `records.content`, `versions.content`, `types.schema`, `journal.ops`, `journal.actor` (a `ChangeActor`) and `journal.associations` (an `AssociationChange[]`).
- **SQL `NULL` is an absent optional field**, with two exceptions, each because `NULL` alone cannot carry what the column must. In the two element tables every column is `NOT NULL` and `''` marks one that does not apply to the element: those columns are the primary key, and SQLite holds two keys differing only by a `NULL` distinct, so two identical tags would both be stored. In `journal.previous_parent_id`, `NULL` is an entry naming no origin and `''` the root: the column has three states to carry — no move, off the root, out of a container — as [the entry](./journal.md#the-entry) distinguishes them.
- **An actor is two columns**, a subject and a principal: `createdBy` is `entity_id` and `principal_id`, and `updatedBy` is `updated_by` and `updated_via`, on both `records` and `versions`.

An association's `attachment_record_id` sits outside its key, as [Attachments § Naming the upload a reference came from](./attachments.md#naming-the-upload-a-reference-came-from) requires.

### Columns

Every column of every table but `records_fts`, an FTS5 index over `records.content` whose own tables are the engine's. Each column is the field it names, under the rules above.

| Table           | Columns                                                                                                                                                                         |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `format`        | `id`, `version`                                                                                                                                                                 |
| `records`       | `id`, `type_id`, `created_at`, `updated_at`, `content`, `version`, `parent_id`, `entity_id`, `app_id`, `principal_id`, `updated_by`, `updated_via`, `deleted_at`, `unlisted_at` |
| `associations`  | `record_id`, `kind`, `label`, `file_id`, `related_scope`, `related_id`, `related_ns`, `related_stack`, `attachment_record_id`                                                   |
| `permissions`   | `record_id`, `kind`, `label`, `grantee_kind`, `grantee_id`, `role`                                                                                                              |
| `versions`      | `record_id`, `version`, `type_id`, `content`, `updated_at`, `entity_id`, `principal_id`, `updated_by`, `updated_via`                                                            |
| `journal`       | `record_id`, `seq`, `at`, `kind`, `ops`, `version`, `type_id`, `parent_id`, `previous_parent_id`, `actor`, `associations`                                                       |
| `types`         | `id`, `base_id`, `version`, `name`, `schema`, `schema_hash`, `migrates_from`, `created_at`                                                                                      |
| `content_index` | `record_id`, `field`, `value_rank`, `num_value`, `text_key`, `text_value`, `file_id`                                                                                            |

The `_config` row carries `{ ownerEntityId }` as its content: the stack's owner, which every store is created holding.

`content_index` and `records_fts` are rebuilt from `records.content`, so a reader may ignore them. A writer may not: a row whose content moved without them answers queries for content it no longer holds. They are part of the layout all the same, so a change to how either is built is a layout change like any other, made by copying into a new store, which rebuilds both as it writes.

## Tokens and installs

**Tokens.** A bearer token, and the delegation it names, is a credential the host issued; `LocalAdapter` keeps them in a sibling file (`<path>.tokens`) that is never part of the stack. The new host issues its own, and a key that earned one before earns one there the same way: a `did:key` names its public key, so nothing about it is tied to a host. The owner asserts each delegation again, [out of band](./identity.md#authentication-challengeresponse) as before.

**Installs are Records.** `_install`, `_app` and `_grant` Records are copied as recorded, so an installed app keeps its approved versions and grants under the same key. Whether it can reach the new host is the app's configuration — it is told the new URL — not the stack's.
