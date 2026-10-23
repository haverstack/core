# Portability

**A stack can leave its host whole.** Every Record, soft-deleted and unlisted ones included, keeps its authorship, its version history and its journal, and every Type and attachment comes with it. Moving needs nothing from the host beyond what it already serves its owner. Identity moves with the stack and the address does not: the new host serves the same owner DID, which a client confirms with `APIAdapter`'s `ownerEntityId` option ([Wire format § Identity is trusted on transport](./wire-format.md#identity-is-trusted-on-transport)). References to the old `stackUrl`, a Group's or a relationship target's, are updated by hand.

## Copying a stack

```ts
import { copyStack } from '@haverstack/core/adapter';

await copyStack(from, to);
```

**One primitive carries export, import and every move between storage engines.** `copyStack()` reads a whole stack from one `StackAdapter` and writes it to another; which pair of adapters it is given is the only difference between exporting to [the portable format](#the-portable-format), importing from it, and moving a stack from one SQLite engine to another. No adapter has an export or import method of its own, so N adapters need N implementations of the [write below](#writing-history), not one converter per pair of formats.

What it carries:

- **Every Type**, through `listTypes()` and `saveType()`.
- **Every Record but `_config`**, soft-deleted and unlisted ones included, each with every version snapshot and every journal entry, through [`importRecord()`](#writing-history). `_config` is the store's own: no query reaches it, and the target was created holding the source's identity.
- **The bytes every [`_attachment` family](./attachments.md#finding-a-fileids-metadata-records) record names**, soft-deleted and unlisted ones included: the files [garbage collection](./attachments.md#garbage-collection) weighs, so a collection on the target reaches the decision one on the source would have. Bare bytes no record names are garbage already, and stay behind.

Nothing a purge destroyed is carried, because the source no longer holds it.

**It is a full-trust operation, like any direct adapter access.** It writes authorship and history as recorded, which no write through `Stack` may: a scoped create is stamped with its requester, and nothing outside a write appends a snapshot or a journal entry. It takes adapters rather than stacks because those are where that trust already lives ([Adapters § Concurrency & storage ownership](./adapters.md#concurrency--storage-ownership)). It emits no [change events](./events.md) and appends no journal entry: it reproduces changes that already happened, each of which was announced and journaled when it did.

**The target is a store newly created with the source's identity.** Its owner is checked as `open()` checks a store's ([Adapters § Construction](./adapters.md#construction)). Its `timezone` is not: it is passthrough metadata a store takes only when it is created, so the target is created with `from.timezone`, as any new store is created with the timezone it should hold. `copyStack()` refuses a target before writing anything:

| Target                                  | Refusal                                          |
| --------------------------------------- | ------------------------------------------------ |
| No `importRecord()`                     | `InvalidAdapterError`                            |
| Another `ownerEntityId`                 | `OwnerMismatchError`, `where: 'the copy target'` |
| Holds a Record, deleted or unlisted too | `StackConflictError`                             |

A store `Stack.open()` has opened holds the system Types and no Record, so it is a valid target unless `ownerProfile` created the owner's card in it. Types are saved over, which is why a target may hold them: the only ones a new store holds are the system Types, which every stack defines alike.

**It is not atomic.** A failure part-way leaves the target partly written; it is discarded and the copy run again into a new one, never resumed.

**The source is read only through methods every adapter has**, so it may be an `APIAdapter` opened as the owner, who reads every Record, every version and every journal entry in full.

## Writing history

```ts
importRecord?(record: StackRecord, history: RecordHistory): Promise<void>;

type RecordHistory = {
  versions: RecordVersion[];
  journal: RecordJournalEntry[];
};
```

`StackRecordAdapter.importRecord()` is `createRecord()` for a Record that already has a past, and the adapter contract's only write of a whole history. It writes the Record exactly as given — `version`, `createdAt`, `updatedAt`, `createdBy`, `updatedBy`, `deletedAt`, `unlistedAt`, its associations and its permissions — beside each version snapshot and each journal entry as recorded, `seq` and `at` included.

- **One atomic write**, under [the rule every mutating record method follows](./adapters.md#interface-split): a refused import leaves no row behind.
- **`StackConflictError` when `record.id` exists**, as `createRecord()` throws.
- **It appends no journal entry of its own.** The entries it is handed are the log.
- **Writes after it continue the history it wrote.** The next bump snapshots the version the import left and moves past it, and the next entry's `seq` is [allocated from the log's maximum](./journal.md#ordering) as always.

**It is handed history a Record can have**, as every adapter method is held only to what its caller produces ([Adapters § Interface split](./adapters.md#interface-split)): every snapshot's `version` is below `record.version` — one at the record's own version is [an orphan](./versioning.md#snapshot-atomicity) — and every entry's `seq` is distinct. What an adapter does with anything else is unspecified. Order is not part of the input: snapshots are keyed by `version` and entries by `seq`, and reading them back orders them as `getVersions()` and `getJournal()` always do.

`RecordHistory` is what `getVersions()` and `getJournal()` return, so an adapter reads a Record's history out in the shape another writes it in.

**Optional, and every local adapter implements it.** It is optional only so `APIAdapter` can leave it out, as [`queryReadable()`](./adapters.md#querying-within-a-reach) is. A server is the only writer of its own durable tiers ([Versioning § Snapshot atomicity](./versioning.md#snapshot-atomicity)), and the wire carries no endpoint writing either one, so a stack behind an `APIAdapter` cannot be copied into. The [conformance suite](./adapters.md#conformance) holds an adapter declaring it to every rule above, and `runCopyConformance()` holds a full adapter to the round trip: a stack with a past copied in and back out, unchanged at both hops.

## The portable format

**An export is a `LocalAdapter` store: a SQLite database, with an `attachments/` directory beside it.** It is a working stack, not an archive to unpack — `Stack.open()` reads it as it reads any local stack.

```ts
// Export: the host's stack, into a new portable store.
const exported = await LocalAdapter.open({
  path: './my-stack.db',
  create: 'exclusive',
  ownerEntityId: host.ownerEntityId,
  timezone: host.timezone,
});
await copyStack(host, exported);
await exported.close();

// Import: the portable store, into a new host's empty one.
await copyStack(await LocalAdapter.open({ path: './my-stack.db' }), newHost);
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

The `_config` row carries `{ entityId, timezone }` as its content: the stack's owner and timezone, which a store is created with.

`content_index` and `records_fts` are rebuilt from `records.content`, so a reader may ignore them. A writer may not: a row whose content moved without them answers queries for content it no longer holds.

## Tokens and installs

**Tokens.** A bearer token, and the delegation it names, is a credential the host issued; `LocalAdapter` keeps them in a sibling file (`<path>.tokens`) that is never part of the stack. The new host issues its own, and a key that earned one before earns one there the same way: a `did:key` names its public key, so nothing about it is tied to a host. The owner asserts each delegation again, [out of band](./identity.md#authentication-challengeresponse) as before.

**Installs are Records.** `_install`, `_app` and `_grant` Records are copied as recorded, so an installed app keeps its approved versions and grants under the same key. Whether it can reach the new host is the app's configuration — it is told the new URL — not the stack's.
