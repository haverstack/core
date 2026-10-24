# Portability

**A stack can leave its host whole.** Every Record, soft-deleted and unlisted ones included, keeps its authorship, its version history and its journal, and every Type and attachment comes with it. Moving needs nothing from the host beyond what it already serves its owner. Identity moves with the stack and the address does not: the new host serves the same owner DID, which a client confirms with `APIAdapter`'s `ownerEntityId` option ([Wire format § Identity is trusted on transport](./wire-format.md#identity-is-trusted-on-transport)). References to the old `stackUrl`, a Group's or a relationship target's, are updated by hand.

## Copying a stack

```ts
import { copyStack } from '@haverstack/core/adapter';

const target = await copyStack(from, (identity) => createStore(identity));

type StackIdentity = { ownerEntityId: EntityId; timezone: string | undefined };
```

**One primitive carries export, import and every move between storage engines.** `copyStack()` reads a whole stack from one `StackAdapter` and writes it into a new store, which it asks `create` to make with the source's identity and returns open. Which source it is given, and what kind of store `create` makes, is the only difference between exporting to [the portable format](#the-portable-format), importing from it, and moving a stack from one SQLite engine to another. No adapter has an export or import method of its own, so N adapters need N implementations of the [write below](#writing-history), not one converter per pair of formats.

What it carries is everything the source holds:

- **Every Type**, through `listTypes()` and `saveType()`.
- **Every Record but `_config`**, soft-deleted and unlisted ones included, each with every version snapshot and every journal entry, through [`importRecord()`](#writing-history). `_config` is the store's own: no query reaches it, and `create` made the target with what it holds.
- **[Every blob the stack holds](./attachments.md#the-blobs-a-stack-holds)**: every one its blob store lists, and every file a Record names. A name whose bytes are gone stays dangling, as it was.

Nothing is filtered on the way: deciding what is garbage is the target's own [collection](./attachments.md#garbage-collection), run when its owner chooses, and nothing a purge destroyed is carried, because the source no longer holds it.

**It is a full-trust operation, like any direct adapter access.** It writes authorship and history as recorded, which no write through `Stack` may: a scoped create is stamped with its requester, and nothing outside a write appends a snapshot or a journal entry. It takes adapters rather than stacks because those are where that trust already lives ([Adapters § Concurrency & storage ownership](./adapters.md#concurrency--storage-ownership)). It emits no [change events](./events.md) and appends no journal entry: it reproduces changes that already happened, each of which was announced and journaled when it did.

**The target is created with the source's identity, so the identity travels by construction.** `create` receives the source's `ownerEntityId` and `timezone`, as any new store is opened with them ([Adapters § Construction](./adapters.md#construction)). What it returns is held to one rule: it is a store as its adapter creates one with that identity — that owner and timezone, holding nothing — on an adapter with `importRecord()`. Anything else is a mistake in `create`, refused with `InvalidAdapterError` before anything is written. A store `Stack.open()` has opened is not one: it holds the [system Types](./data-model.md#system-types). The copy brings the source's own, which are part of what it holds, and a later `Stack.open()` of the target meets them as it meets any store's.

**It is not atomic.** A failure part-way, the refusal included, closes the target; it is discarded and the copy run again into a new one, never resumed.

**The source is read only through methods every adapter has**, so it may be an `APIAdapter` opened as the owner, who reads every Record, every version and every journal entry in full.

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

**It is handed history a Record can have**, as every adapter method is held only to what its caller produces ([Adapters § Interface split](./adapters.md#interface-split)): every snapshot's `version` is below `record.version` — one at the record's own version is [an orphan](./versioning.md#snapshot-atomicity) — and the entries' `seq` values run [dense from 1](./journal.md#ordering), as every log's do. What an adapter does with anything else is unspecified. Order is not part of the input: snapshots are keyed by `version` and entries by `seq`, and reading them back orders them as `getVersions()` and `getJournal()` always do.

`RecordHistory` is what `getVersions()` and `getJournal()` return, so an adapter reads a Record's history out in the shape another writes it in.

**Optional, and every local adapter implements it.** It is optional only so `APIAdapter` can leave it out, as [`queryReadable()`](./adapters.md#querying-within-a-reach) is. A server is the only writer of its own durable tiers ([Versioning § Snapshot atomicity](./versioning.md#snapshot-atomicity)), and the wire carries no endpoint writing either one, so a stack behind an `APIAdapter` cannot be copied into. The [conformance suite](./adapters.md#conformance) holds an adapter declaring it to every rule above, and `runCopyConformance()` holds a full adapter to both halves of a copy: a stack with a past, written into one store it creates and copied into a second, arrives unchanged.

## The portable format

**An export is a `LocalAdapter` store: a SQLite database, with an `attachments/` directory beside it.** It is a working stack, not an archive to unpack — `Stack.open()` reads it as it reads any local stack.

```ts
const portable = (path: string) => (identity: StackIdentity) =>
  LocalAdapter.open({ path, create: 'exclusive', ...identity });

// Export: the host's stack, into a new portable store.
const exported = await copyStack(host, portable('./my-stack.db'));
await exported.close();

// Import: the portable store, into a store created however the new host creates one.
const exportedStack = await LocalAdapter.open({ path: './my-stack.db' });
await copyStack(exportedStack, createHostStore);
```

The layout is specified here so an export stays readable without the tool that wrote it, and a change to it changes this section in the same change.

**`attachments/<fileId>`** holds a blob's bytes, named by the [64-character lowercase hex SHA-256](./attachments.md) of its contents.

**The database** holds six tables that are sources of truth and two that are [derived](./adapters.md#sqlite-backed-adapters):

| Table           | One row per                     | Key                                                                                                   |
| --------------- | ------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `records`       | Record, `_config` included      | `id`                                                                                                  |
| `associations`  | data association                | `record_id`, `kind`, `label`, `file_id`, `related_scope`, `related_id`, `related_ns`, `related_stack` |
| `permissions`   | permission element              | `record_id`, `kind`, `label`, `grantee_kind`, `grantee_id`, `role`                                    |
| `versions`      | version snapshot                | `record_id`, `version`                                                                                |
| `journal`       | journal entry                   | `record_id`, `seq`                                                                                    |
| `types`         | Type                            | `id`                                                                                                  |
| `content_index` | derived: top-level scalar field | `record_id`, `field`                                                                                  |
| `records_fts`   | derived: full-text index entry  | `rowid` of the `records` row                                                                          |

Their columns follow four encoding rules:

- **Times are integers**, milliseconds since the Unix epoch.
- **Structured values are JSON text**: `records.content`, `versions.content`, `types.schema`, `journal.ops`, `journal.actor` (a `ChangeActor`) and `journal.associations` (an `AssociationChange[]`).
- **SQL `NULL` is an absent optional field**, except in the two element tables, where every column is `NOT NULL` and `''` marks one that does not apply to the element; and in `journal.previous_parent_id`, where `NULL` is an entry naming no origin and `''` the root, as [the entry](./journal.md#the-entry) distinguishes them.
- **An actor is two columns**, a subject and a principal: `createdBy` is `entity_id` and `principal_id`, and `updatedBy` is `updated_by` and `updated_via`, on both `records` and `versions`.

The remaining columns are the fields they name: `records` holds `type_id`, `created_at`, `updated_at`, `content`, `version`, `parent_id`, `app_id`, `deleted_at` and `unlisted_at`; `versions` holds `type_id`, `content` and `updated_at`; `journal` holds `at`, `kind`, `version`, `type_id` and `parent_id`; `types` holds `base_id`, `version`, `name`, `schema`, `schema_hash`, `migrates_from` and `created_at`. An association's `attachment_record_id` sits outside its key, as [Attachments § Naming the upload a reference came from](./attachments.md#naming-the-upload-a-reference-came-from) requires.

The `_config` row carries `{ entityId, timezone }` as its content: the stack's owner and timezone, which a store is created with and `copyStack()` hands to `create`.

`content_index` and `records_fts` are rebuilt from `records.content`, so a reader may ignore them. A writer may not: a row whose content moved without them answers queries for content it no longer holds.

## Tokens and installs

**Tokens.** A bearer token, and the delegation it names, is a credential the host issued; `LocalAdapter` keeps them in a sibling file (`<path>.tokens`) that is never part of the stack. The new host issues its own, and a key that earned one before earns one there the same way: a `did:key` names its public key, so nothing about it is tied to a host. The owner asserts each delegation again, [out of band](./identity.md#authentication-challengeresponse) as before.

**Installs are Records.** `_install`, `_app` and `_grant` Records are copied as recorded, so an installed app keeps its approved versions and grants under the same key. Whether it can reach the new host is the app's configuration — it is told the new URL — not the stack's.
