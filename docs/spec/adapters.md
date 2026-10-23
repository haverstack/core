# Adapters

## Interface split

The adapter contract is split into two focused interfaces that are composed into a single `StackAdapter`:

**`StackRecordAdapter`** — structured storage: capabilities, stack identity (`ownerEntityId`, `timezone`), all record/association/version/type methods, and optional lifecycle hooks (`flush`, `close`).

**The contract covers what `Stack` sends, and nothing else.** Apps never call an adapter directly, and `Stack` validates every input before an adapter sees it, so an adapter is held to the inputs `Stack` produces — a list naming each identity once, a write that moves something, a well-formed element, a query with every default resolved ([Sorting and pagination](./data-model.md#sorting-and-pagination)). What an adapter does with any other input is unspecified, and the [conformance suite](#conformance) does not test it.

**One aspect, one adapter method.** The record writes narrow exactly as [`StackClient`'s do](./data-model.md#mutations): `patchContent`, `setParent`, `setUnlisted`, `editAssociations`, `setAssociations`, `editAccess` and `setAccess`, beside the lifecycle methods `deleteRecord`, `undeleteRecord`, `restoreVersion` and `commitMigration`. Whether a write bumps follows from which method it is — `patchContent` and the lifecycle methods always write a snapshot and bump `version` once; the six aspect writes never do, and leave `version`, `updatedAt` and the actor stamps where they stand (see [Versioning § Version history](./versioning.md#version-history)). Each maps to one request over [the wire](./wire-format.md#records), so the adapter contract promises no atomicity across aspects that `APIAdapter` could not keep. `Stack` still owns everything above storage — the acyclicity walk, schema validation, the per-verb gates — and hands an adapter only a write that moves something.

**Every method takes `ifVersion`, checked inside its own write** — an `UPDATE … WHERE version = ?` on the records row, or a check-then-write inside one transaction for the methods that touch another table. See [Versioning § Optimistic concurrency](./versioning.md#optimistic-concurrency-ifversion).

**The six aspect writes refuse a soft-deleted record, checked inside the same write and before `ifVersion` or `expectSet`.** The write throws `softDeletedRefusal(id)` — the `StackConflictError` `Stack` itself throws for a tombstone — and changes nothing, journal included. It is final: `Stack` passes it to the caller rather than reading again. See [Versioning § An aspect write never lands on a tombstone](./versioning.md#an-aspect-write-never-lands-on-a-tombstone).

**Every mutating record method is atomic, whatever it touches.** A record write is rarely one statement — a create alone writes the record row, its associations, the full-text index, the content index and a [journal entry](./journal.md) — and an adapter must apply the whole set or none of it. Partial application is worse than failure: the method raises, so the caller takes the write as lost, while what survives contradicts that and can outlive the retry. The [snapshot's atomicity rule](./versioning.md#snapshot-atomicity) is one instance of this, not a separate one.

**`getJournal()` refuses a record that isn't there.** `StackNotFoundError`, never an empty log — a purged record is gone, so it gets the same refusal. See [Change journal § Reading it](./journal.md#reading-it).

**`StackBlobAdapter`** — binary storage: `putBlob`, `getBlob`, `deleteBlob`, an optional `listBlobs()` capability, and optional lifecycle hooks. The names are deliberately not `*Attachment`: an attachment is the managed, record-backed concept at the `Stack` layer — permission-checked, reference-checked, carrying metadata — while a blob is the raw bytes beneath it. `putAttachmentWithMetadata()` (below) keeps its name because it really is the attachment operation.

**`StackBlobAdapter` error contract:** `getBlob(fileId)` throws `StackNotFoundError` when no blob exists for `fileId`, and `StackBadRequestError` when `fileId` itself is malformed (not a 64-character lowercase hex string) — the same two conditions the wire format reports as 404 and 400, so an app written against a local adapter and one written against the API adapter can `instanceof`-check the same classes. Implementations must not return empty/placeholder bytes for an absent fileId. `getBlob()` returns a plain `Uint8Array` (prototype exactly `Uint8Array.prototype`, never a subclass such as `Buffer`) that the caller owns: changing it never changes the stored bytes, and changing the array passed to `putBlob()` afterwards never changes the stored copy. See [Attachments](./attachments.md).

```ts
type StackAdapter = StackRecordAdapter &
  StackBlobAdapter & {
    // Optional: bytes + _attachment@1 record as one atomic operation
    putAttachmentWithMetadata?(data: Uint8Array, opts: PutAttachmentOptions): Promise<StackRecord>;
  };
```

**Optional capabilities** follow one pattern throughout: an optional interface method, checked for truthiness at the call site, with a described fallback when absent. `StackRecordAdapter.deleteUnreferencedAttachmentRecords()` (atomic reference check — see [Attachments](./attachments.md#deleting-attachments)), `StackRecordAdapter.queryReadable()` (a query among the Records one requester may read; a stack is not scoped without it — see [below](#querying-within-a-reach)), `StackRecordAdapter.importRecord()` (a Record written with its whole history; a stack cannot be copied into without it — see [Portability § Writing history](./portability.md#writing-history)), `StackBlobAdapter.listBlobs()` (blob enumeration, used by [garbage collection](./attachments.md#garbage-collection) to find bare-bytes orphans), `StackRecordAdapter.subscribeChanges()` (relaying a feed that originates elsewhere — see [Change events § Where events come from](./events.md#where-events-come-from)), and `StackAdapter.putAttachmentWithMetadata()` (atomic upload, below) are all this shape — no boolean flag in `capabilities`, just an optional method a caller checks for before using. `combineAdapters()` (below) preserves this: it forwards an optional method only when the underlying part actually implements it, never as a wrapper around a missing one.

`StackAdapter.putAttachmentWithMetadata(data, { mimeType, filename?, appId? })` stores bytes and creates the accompanying `_attachment@1` record as **one atomic operation**, returning the created record. It is declared on the composed `StackAdapter` type rather than on either half, because neither half can ever have it: "bytes + record in one operation" is a property only a whole adapter can offer. Exactly one adapter does: the API adapter, backed by a single `POST /attachments` request the server fulfills atomically. Local storage adapters don't implement it, and `combineAdapters()` never synthesizes it from parts (a record backend and a blob backend glued together have no shared transaction). `Stack.putAttachment()` checks for it — present means delegate the whole operation and trust the returned record as backend-authoritative; absent means the bytes-then-`create()` fallback sequence. See [Wire format § Attachments](./wire-format.md#attachments) for why the atomic form is a correctness requirement, not an efficiency optimization.

### Associations are keyed by identity

Every adapter stores a record's associations under the [identity](./data-model.md#associations) they carry — `(kind, label)` plus `fileId` or the target — so an `editAssociations()` add landing on an identity already stored overwrites it in place rather than adding a second row. Permission elements are keyed the same way, by kind, label and the whole grantee, `role` included. It is the association table's primary key in a SQL adapter, and an adapter over some other engine owes the same behavior rather than the engine's default. `Stack` hands an adapter only lists naming each identity once, so no adapter is ever asked to choose between two.

### Editing associations

`StackRecordAdapter.editAssociations(id, edits, opts?)` takes a list of `AssociationEdit` — `add` and `remove`, the [journal's shape](./journal.md#the-entry) without `repoint` — and applies it as **one write**, so a swap never exposes an intermediate state. `editAccess()` is the same contract over the record's permissions, so a paired grant of `read` and `write` lands together.

- **All or none.** A SQL adapter runs the list in one transaction; a failure part-way leaves the record as it stood.
- **An add landing on an identity already stored overwrites it in place.** `Stack` hands an adapter only a list naming each identity once, so the order of its edits is never observable.
- **Never bumps `version` or `updatedAt`, and never snapshots.** One call appends at most one [journal entry](./journal.md#the-entry), carrying the `JournalEntryInput` the caller passed.
- **A record that is not there is `StackNotFoundError`**, never an orphan row.
- **`expectSet`, when given, is compared inside the write.** If the stored set differs from it — by element or annotation, order aside — the write throws `ElementSetMovedError` and changes nothing. `Stack` always passes the set it read, so the rules it asked of that set hold for the set the write lands on; see [Versioning § Element-set writes compare the set they read](./versioning.md#element-set-writes-compare-the-set-they-read). `APIAdapter` does not send it: the server's own `Stack` makes the same comparison inside the request.

`setAssociations()` and `setAccess()` replace the whole set in their own table under the same rules; `setAccess(id, [])` leaves the record private.

`repoint` is not an input: `Stack` computes it against the record it read and hands it to the adapter only inside the journal entry.

## Querying within a reach

`StackRecordAdapter.queryReadable(query, reach)` answers `queryRecords(query)` among the Records a `Reach` names, and nothing else. It is how a [permission-scoped](./access-control.md#enforcement-stackasentity) `query()` reads: `ScopedStack` hands the adapter the requester's `read` [reach](./access-control.md#reach), so the page, its cursor and whether a cursor comes back are decided among Records the requester may read — see [Refusals and disclosure § What a query reveals](./disclosure.md#what-a-query-reveals) for why that matters.

```ts
type Reach = {
  fence?: BaseId[];
  within?: {
    baseIds: BaseId[];
    authored?: { subjectId: EntityId; baseIds: BaseId[] };
    permissions: AuthorityAssociation[][];
  };
};
```

The shape and its reading are [Access control § Reach](./access-control.md#reach)'s: each family is matched as [`filter.baseId`](./data-model.md#filter) matches one, against the Record's own `typeId`. The reach is one more condition of the query, beside its own `filter`, so it narrows and never widens. Every rule behind it is resolved before the adapter sees it, so the adapter applies none of access control: it matches a description, the way it matches a `filter`. `inReach()` in `@haverstack/core/adapter` is the reference reading, and the [conformance suite](#conformance) holds an adapter to it.

**Every local adapter implements it.** It is optional only so `APIAdapter` can leave it out: a stack whose adapter lacks it [cannot be scoped at all](./access-control.md#enforcement-stackasentity), which a server-backed stack never needs. A reach is sized by the requester's grants and rosters, not by anything the adapter controls, so a SQLite adapter binds each list in it as one parameter, the permission sets included — the rule it holds every part of a query to; see [Statement size](#statement-size). It matches each permission element through an index on the element's identity ending in `record_id`, the same semi-join shape as the association filters.

## Package naming convention

Packages follow a naming convention that makes the adapter type discoverable:

- **`adapter-*`** — full `StackAdapter` (convenience packages covering both halves)
- **`record-adapter-*`** — `StackRecordAdapter` only
- **`blob-adapter-*`** — `StackBlobAdapter` only

## Adapter backends

| Package                    | Type   | Use case                                                                     |
| -------------------------- | ------ | ---------------------------------------------------------------------------- |
| `adapter-local`            | full   | Local app storage — native SQLite + disk blobs                               |
| `record-adapter-sqlite`    | record | Node native SQLite (`node:sqlite`) records, FTS5, WAL                        |
| `record-adapter-do-sqlite` | record | Cloudflare Durable Objects (SQLite storage) records, FTS5                    |
| `blob-adapter-disk`        | blob   | Content-addressed blobs on disk                                              |
| `blob-adapter-s3`          | blob   | Content-addressed blobs on S3 or an S3-compatible store (e.g. Cloudflare R2) |
| `adapter-api`              | full   | Hosted/shared stacks via HTTP                                                |
| `adapter-json`             | full   | Portable JSON files _(planned)_                                              |

`adapter-local` is the batteries-included package for the common local case. It wraps `NativeSQLiteRecordAdapter` and `DiskBlobAdapter` and stores attachments in an `attachments/` subdirectory next to the database file. Bearer tokens, when used, live in a separate sibling file (`<path>.tokens`, via `NativeTokenStore`) — never inside the portable stack database.

Use `combineAdapters()` from `@haverstack/core/adapter` when you want different backends for records and blobs — for example, native SQLite records with S3 blob storage:

```ts
import { combineAdapters } from '@haverstack/core/adapter';
import { NativeSQLiteRecordAdapter } from '@haverstack/record-adapter-sqlite';
import { S3BlobAdapter } from '@haverstack/blob-adapter-s3';

const record = await NativeSQLiteRecordAdapter.open({
  path,
  create: 'exclusive',
  ownerEntityId,
  timezone,
});
const blob = new S3BlobAdapter({ bucket: 'my-bucket' });
const adapter = combineAdapters({ record, blob });
const stack = await Stack.open(adapter);
```

`limits.attachmentBytes` lives on `StackCapabilities` (below), which `combineAdapters()` always reads from the `record` half — a blob-only package like `blob-adapter-s3` has no ceiling of its own to declare. Whichever `StackRecordAdapter` it's paired with should keep declaring `null`, per [the local-adapter rule](#adapter-capabilities) below: a blob adapter isn't the wire boundary that would justify one. Point `S3BlobAdapter` at Cloudflare R2 or another S3-compatible store by passing `endpoint` and `forcePathStyle: true`.

All adapters support the full Record API. Performance guarantees differ; correctness does not.

## Construction

An adapter that holds a stack's identity has exactly one entry point, an async static `open(opts)`, and no public constructor. Whether `open()` may create a new stack is an option, not a separate method. Blob adapters hold no identity and keep their public constructors. `Stack.open(adapter)` stays a separate step, because `combineAdapters()` sits between the two.

| Adapter                                             | Entry point                                   | `create`                                          |
| --------------------------------------------------- | --------------------------------------------- | ------------------------------------------------- |
| `LocalAdapter`, `NativeSQLiteRecordAdapter`         | `open({ path, create?, ownerEntityId?, … })`  | `'never'` (default), `'ifMissing'`, `'exclusive'` |
| `DoSQLiteRecordAdapter`                             | `open(storage, { ownerEntityId, timezone? })` | none: always creates if missing                   |
| `APIAdapter`                                        | `open({ url, ownerEntityId?, … })`            | none: a client never creates                      |
| `MemoryAdapter`, `IncapableMemoryAdapter` (testing) | `open({ ownerEntityId, timezone? })`          | none: always new                                  |

`create` names what `open()` does when the store is missing or present, like `O_CREAT`/`O_EXCL`:

- `'never'`: open an existing store, fail if missing.
- `'ifMissing'`: open it if present, create it if not.
- `'exclusive'`: create it, fail if present.

`ownerEntityId` follows one rule everywhere it is accepted:

- **Required whenever `open()` may create.** The type makes it required for `'ifMissing'` and `'exclusive'`, on the DO adapter and on `MemoryAdapter`. No adapter defaults it to `''`.
- **A plain string or a lazy `() => string | Promise<string>`** on every creating path, called only when a store is actually created.
- **A plain string is checked against an existing store's owner**, in every mode and on every adapter; a mismatch throws `OwnerMismatchError` (`expected`, `actual`, and a `where` naming the path, URL or Durable Object) and releases anything `open()` had acquired. A lazy provider is never called just to compare.

`OwnerMismatchError` is exported from `@haverstack/core/adapter`, outside the `StackError` taxonomy alongside `InvalidAdapterError`: it reports a setup mistake, not a state a request can be in.

## Conformance

The invariants above are easy to state in prose and easy to violate silently — FTS5's external-content index going stale, a content path matching an unfiltered superset, a cursor replayed under the wrong sort. **`@haverstack/adapter-conformance`** is the runnable form of this document: `runRecordAdapterConformance()` and `runBlobAdapterConformance()` take an `open()` for your adapter and its declared `capabilities`, and register a vitest suite checking exactly the invariants named here, gated so a capability you don't declare is never penalized for its absence. `record-adapter-sqlite` and `blob-adapter-disk` both run it against themselves (`tests/conformance.test.ts`), alongside `@haverstack/core`'s own `MemoryAdapter` — three independent implementations passing the same suite is the check that the suite describes the contract rather than one adapter's accidents. `runCopyConformance()` takes an `open()` for a full adapter and checks the [round trip](./portability.md#copying-a-stack) a move between hosts makes through it; `adapter-local` runs it against itself.

## SQLite-backed adapters

**`@haverstack/sqlite-shared`** is an internal, non-public package holding everything a SQLite-backed record adapter needs that isn't specific to one binding — schema DDL and the function that applies it, `WHERE`/`ORDER` building, the cursor codec, row mappers, the FTS5 sanitizer and indexing strategy, the storage-ownership lock, the `_config` record's reader and writer, the capability declaration every engine running this query builder makes, and (via a small `SqlExecutor` interface normalizing a binding's call convention) the actual CRUD/query/version/type/association/token logic itself. `SharedSqlRecordAdapter` is where the last of those meet: an abstract base implementing all of `StackRecordAdapter` by forwarding to that logic, so an adapter supplies only what's genuinely engine-specific — constructing the database handle, transaction semantics, and its own lifecycle (`flush`/`close`, the two members the base leaves abstract). `record-adapter-sqlite` and `record-adapter-do-sqlite` both consume it; the split exists so a second (and third) SQLite engine inherits the behavior rather than reimplementing it, and so a cursor minted by one is decodable by another.

**It exposes two entry points.** The full barrel (`.`) includes the token-store logic (`SharedTokenLogic`, `TOKENS_SCHEMA_SQL`) and the file-lock helpers, both Node-specific (`node:crypto`, `node:fs`) — fine for `record-adapter-sqlite`, but a bare `import` of either survives tree-shaking as a dead-but-still-imported module in a bundle, which throws at load time in a Workers runtime without `nodejs_compat`. A record-only consumer with no token store and no lock file — `record-adapter-do-sqlite`, where the platform's single-writer-per-id model already is the lock — imports the `./record` subpath instead, which never reaches either.

**It is bundled into its consumers rather than published.** "Non-public" is enforced, not merely intended: the package is `private`, and its consumers inline it at build time, so installing one of them from the registry never resolves `@haverstack/sqlite-shared` and cannot depend on it. `SqlExecutor`, `SharedSqlRecordAdapter` and the `Shared*Logic` classes are therefore internal collaborators of the adapters in this repository, not an extension point — a second SQLite engine inherits them by living here, not by installing them. Reversing that (publishing it so third-party adapters can build on `SqlExecutor`) is a deliberate decision to make it public API with the stability obligations that implies, not a packaging tweak. Bundling covers the emitted types as well: because these internals surface in a consumer's own public signatures, each consumer's declaration build inlines them, so a shipped `.d.ts` never names `@haverstack/sqlite-shared` either. `pnpm run verify:pack` checks both halves — that the package is absent from a clean install, and that no shipped declaration imports it.

`SqlExecutor` is synchronous. Every SQLite binding in scope executes queries in-process without yielding, and the shared logic's explicit transaction boundaries (`SqlExecutor.transaction(fn)`) depend on that — an engine reached over a network (D1, libsql over HTTP) does not fit this interface without making it async throughout. `transaction(fn)` — not raw `BEGIN`/`COMMIT`/`ROLLBACK` strings — is the interface's transaction primitive specifically because it isn't universal SQL text: `record-adapter-sqlite` implements it as literal `BEGIN`/`COMMIT`/`ROLLBACK` around `fn()`, while `record-adapter-do-sqlite` implements it as `ctx.storage.transactionSync(fn)`, because Durable Object SQLite storage rejects raw multi-statement transaction SQL outright and does not auto-commit-then-roll-back on a later exception — verified against the real Workers runtime, not assumed. A binding that only had the three raw statements to work with couldn't reach that primitive at all.

SQLite-backed adapters enable foreign-key enforcement (`PRAGMA foreign_keys = ON`) so that operations like `editAssociations()` against a nonexistent record fail loudly (`StackNotFoundError`) instead of silently creating an orphan row.

**File compatibility:** the adapter produces a standard SQLite file with an FTS5 `records_fts` index. Any adapter reading it needs FTS5, not merely SQLite.

`records_fts` is an external-content index (`content='records'`) declared `columnsize=0`. It carries no copy of the indexed text and no per-row token counts, so it answers `MATCH` — which is all `filter.search` asks of it — but a foreign reader cannot rank against it: `bm25()` and `columnsize()` have no column sizes to read. Ordering a search is a records-column sort here, never a relevance sort. A reader wanting relevance has to build its own index over `records.content` rather than borrow this one.

### The search index is unindexed before the row moves

An external-content index carries no copy of the text it indexes, so removing an entry means handing FTS5 the **old** content: the `('delete', rowid, content)` command, not a plain `DELETE`, which leaves a stale entry still matching. The old content is only readable while the row still holds it, so the unindex step must run **before** the record's content changes or its row is deleted — an adapter that writes the row first leaves the record searchable under content it no longer holds.

This is why a SQLite-backed adapter's write is unindex, write, re-index rather than write-then-reindex, and it applies to every write that can move `content` or `typeId`. `@haverstack/adapter-conformance` pins it from the outside: after a content patch, the record is searchable under its new wording and not under its old.

**Two of this adapter's tables are indexes and two are sources of truth.** `content_index` and `records_fts` are derived from `records.content` and can be dropped and rebuilt; `versions` and `journal` cannot, so they carry their own erasure and permission rules. See [Change journal § Why this is not more duplication](./journal.md#why-this-is-not-more-duplication).

**Content ordering is materialized, not derived.** A `sort.contentField` query reads `content_index`, one row per top-level scalar field a Record holds a value at, carrying the ordered forms in [Sorting by a content field](./data-model.md#sorting-by-a-content-field) — the numeric value, or the folded key and the stored text — plus the file id when the field is a `file-ref`. It is written from `content` on every write that can change content or `typeId`, so a foreign writer that updates a Record without rewriting the row leaves the ordering and the `referencesFileId` filter stale. Nothing reads it as a source of truth: `content` is.

A missing row is not only a stale read. `deleteUnreferencedAttachmentRecords()` decides whether a file is still referenced by looking for one, so a `file-ref` field with no row makes a referenced file look unreferenced, and the attachment's metadata Records are purged rather than refused. A writer that touches `content` without rewriting the row is the one way to reach that.

### Statement size

**A statement's text and its bound parameters never grow with how many entries a query's keys hold.** Durable Object SQLite caps a statement at 100 parameters and 100 KB of text, and a query's size is not the adapter's to choose: a reach is sized by the requester's grants and rosters, a filter by whoever wrote it. A statement that grew with either would fail on one engine for a query another answers, and a declared [capability](#adapter-capabilities) could not promise anything. **Every caller-sized part of a query is a table of rows**, bound as one JSON array of tuples and read through `json_each` as named columns:

- **A list is rows of one column** — a filter's type, app and author lists and its tags, and a reach's type lists. A list of one value binds as that value instead, so an index on its column keeps yielding rows in order; that is a smaller statement, never a larger one.
- **A reach's permission sets** are rows of one element each, naming the set it belongs to and that set's size.
- **`sort.contentFieldByType`** is two tables, the Types ordered by a field and the Types ordered by a constant.
- **The content conditions** — every `filter.content` and `filter.contentPresent` key, and every key of every `filter.contentByType` arm — are one table, each row naming its path, what it asks, and the Type it is scoped to (none for `filter.content`). A record matches when every row scoped to nothing or to its own Type holds. One recursive walk per row matches a segment per step and gathers what the row asks of the values it reaches, so neither the number of conditions nor a path's length adds text.

What remains binds a fixed count: a scalar filter's value, a date bound, a cursor's position, the page's row budget. Since a statement's size is set by its shape and not by its query, every engine running the shared query builder honors the same capability declaration.

## Adapter capabilities

Adapters expose a capabilities object so apps can check what's supported before relying on a feature:

```ts
type StackCapabilities = {
  filter: {
    content: 'none' | 'field' | 'path'; // how far a content filter key may reach
    contentPresent: boolean; // filter.contentPresent is honored
    contentByType: boolean; // filter.contentByType is honored
    search: boolean; // filter.search is honored
  };
  sort: {
    fields: ('createdAt' | 'updatedAt' | 'version')[]; // native columns this adapter can order by
    contentField: boolean; // sort.contentField is honored
    contentFieldByType: boolean; // sort.contentFieldByType is honored
  };
  limits: {
    attachmentBytes: number | null; // upload size ceiling, or null = client can't pre-check
    contentBytes: number | null; // record content/patch size ceiling, same reading of null
  };
};
```

One type, `StackCapabilities`, names both sides: an adapter declares it as `capabilities`, and `StackClient` exposes the same object as `capabilities`. App and plugin code should read `stack.capabilities` rather than going through the adapter directly.

**Each entry is named for the query key it answers for.** `filter.content` gates `filter.content`, `sort.fields` gates `sort.field`, and so on down — so the capability a query needs is derivable from the query rather than memorized, and an error can name the key to look at. `limits` is grouped apart because a ceiling is not a feature to gate on: nothing is refused for lacking one.

**`filter.content` is a ladder, not a set of flags.** The rungs nest — `'path'` is `'field'` plus traversal — so they are one ordered value, which is what keeps "traverses paths but matches no field names" out of the type entirely. A single-segment key (`'did'`) needs `'field'`; a multi-segment key (`'emails.value'`) needs `'path'`. The rungs are separate because a foreign server declaring field matching is promising to match a field _name_, and reading that as a promise to walk a path would hand its client an unfiltered superset presented as a filtered result.

**`'path'` is required for local adapters, and any rung is legitimate for a wire adapter.** "Local" means an adapter that reads/writes its storage in-process, with no network hop to a server that could have its own opinion — `record-adapter-sqlite`, `record-adapter-do-sqlite` (a Durable Object's storage is in-process from that DO's own point of view, even though the DO itself is reached over the network), any future JSON-file adapter, and first-party test doubles standing in for one. For storage a local adapter already owns and reads directly, filtering by `content` is a linear scan over resident data and traversal is the same scan with a deeper predicate — there's no architectural reason to stop short, so a shallower rung is never legitimate there. A remote server reached through `adapter-api` is the one legitimate case: native fields (`typeId`, `parentId`, `createdBy`, dates) are a fixed, indexable schema every server needs anyway, but `content` is an arbitrary, app-defined JSON blob, and a server serving many stacks may reasonably decline to index or full-scan it.

`Stack.query()` enforces this before dispatching — see [Capability-gated filters](./data-model.md#capability-gated-filters). That check is a backstop for the rule above, not a substitute for it: a local adapter that (incorrectly) declared `'none'` would otherwise return an unfiltered superset for every `content` query.

**`filter.contentPresent` sits beside the ladder rather than on it.** It gates `filter.contentPresent`, and is required `true` for local adapters on the same reasoning: asking whether a path holds a value is the same walk with a weaker predicate. It is not a rung because a server promising to match a content value has not thereby promised to answer whether one is there at all. It is meaningful only above `'none'` — presence travels in the `POST /records/query` body, which a server reaching no content does not expose — and a presence path is itself gated by the rung, so a multi-segment one needs `'path'`.

**`filter.contentByType` and `sort.contentFieldByType` are flags, like `filter.contentPresent`.** Each says the [per-Type shape](./data-model.md#content-by-type) is honored, with any number of keys. A local adapter must honor both, on the reasoning that makes `'path'` required: an arm is the content filter it already runs, scoped to one `typeId`, and costs a SQLite adapter no statement text or parameter of its own (see [Statement size](#statement-size)). Neither carries a count, as nothing else a query holds does — `filter.content` keys, `contentPresent` paths and tag lists are unbounded too: a server bounds what a query costs it the one way it bounds all of them, under [Wire format § Bounding query cost](./wire-format.md#bounding-query-cost). A collection facing `false` queries its handle's version alone rather than failing — see [Data model § Content queries across versions](./data-model.md#content-queries-across-versions). Like `filter.contentPresent`, both travel only in the `POST /records/query` body, which a server reaching no content does not serve, so all three are `false` beside `filter.content: 'none'`. The dependency is on that endpoint, not on filtering: a per-Type sort needs it where `sort.contentField`, sent as a query parameter, does not. That holds where capabilities enter, so nothing reading them re-derives it: the [conformance suite](#conformance) holds a local adapter's declaration to it, and `normalizeCapabilities()` applies it to a discovery response.

**`filter.search` has no local-required rule.** A full-text index is a different mechanism from field matching, and neither implies the other, so a local adapter may legitimately decline it (see the JSON adapter note below).

**`sort.contentField` is a boolean, and `sort.fields` names native columns only.** Content fields are app-defined and unbounded, so an adapter cannot enumerate them; and an adapter that indexes content for sorting indexes [every top-level scalar](./data-model.md#sorting-by-a-content-field), so there is nothing per-field left to declare. `sort.contentField` is required `true` for local adapters, and independent of `filter.content`: the two describe ordering and filtering, and a server may offer either without the other — filtering is answerable at whatever scale a server already scans at, where ordering wants an index. Both are enforced: `Stack.query()` refuses a sort the adapter hasn't declared rather than letting it be answered in some other order, which a caller reading one bounded page cannot detect.

**Absent, malformed or unrecognized reads as the least capable value it could stand for.** One rule, for every entry: `'none'` for the reach, `false` for a flag, `createdAt` alone for `sort.fields`, `null` for a limit. A discovery response that omits a group, omits `capabilities` entirely, or names a reach this client has never heard of describes a server this client will not send that query to — silence is never a claim, in either direction, and an unrecognized rung places nowhere on a ladder so it can only be read as its bottom. `normalizeCapabilities()` in `@haverstack/wire-types` applies the rule, so a client reads a foreign discovery response through one function rather than defaulting keys at each use.

**`createdAt` is the floor of `sort.fields`, not nothing.** A query naming no sort reads `createdAt`, newest first ([Sorting and pagination](./data-model.md#sorting-and-pagination)), so every adapter already orders by it, every local adapter declares it, and `normalizeCapabilities()` reads it into any list a server declares. A `null` limit is permissive by design: it says this client cannot pre-check, not that nothing is enforced — the server's own ceiling still answers with a `413`.

**Per-adapter notes:**

- **JSON adapter** — supports all filter fields via O(n) scan; may maintain `_index.json` to speed up native field lookups; `filter.search: false` in v1 (local adapters may decline search; `filter.content: 'path'` is the required one)
- **Native SQLite adapter** (`record-adapter-sqlite`) — indexes all native fields and association labels; supports content field queries and full-text search via FTS5
- **Durable Object SQLite adapter** (`record-adapter-do-sqlite`) — same capabilities as the native SQLite adapter (both extend `SharedSqlRecordAdapter`); DO's SQLite storage ships FTS5
- **API adapter** — capabilities determined by the server; declared in a discovery endpoint; the one adapter kind allowed to declare a `filter.content` rung below `'path'`

Local, embedded adapters (JSON, native SQLite, Durable Object SQLite) declare both limits `null` — nothing at the storage layer imposes a ceiling, and a caller with in-process access to the database can spend its own memory however it likes. Only a server behind the API adapter declares one, since it's the only adapter carrying bytes over a connection with its own limits.

**`limits.attachmentBytes` bounds an upload; `limits.contentBytes` bounds the JSON side of a write** — the serialized size of a Record's `content` on create, or of a patch on a content edit. A server declares its request-size limit as the latter, and `Stack.create()`/`Stack.patchContent()` pre-check against it and throw `StackPayloadTooLargeError` before sending — the same client-side courtesy `putAttachment()` extends for attachments, with the server's own limit still authoritative (see [Wire format § Request size limits](./wire-format.md#request-size-limits)).

## Concurrency & storage ownership

A stack's backing storage (a SQLite file, a JSON directory) has exactly one owning process at a time. Multi-app access goes through a server implementation over the wire protocol (`adapter-api`, against `localhost` or a hosted provider) — never by pointing multiple apps at the same storage file directly. This is also the only topology in which permissions, grants, and `appId` attribution mean anything: `Stack` performs no permission checks, `ScopedStack` is opt-in, and `appId` is self-reported by the writing app, so direct storage access implies full trust over everything in the store, including grants and token hashes.

**A read reflects every write the adapter has committed.** `getRecord()` after a write returns returns what that write left, never an earlier state served from a cache or a replica. `Stack`'s [element-set retry](./versioning.md#element-set-writes-compare-the-set-they-read) ends because of it: each refusal means a newer write landed, which the next read sees.

How each adapter honors the single-writer rule differs by what it actually is:

- **`record-adapter-sqlite`** (Node, real files) writes through `node:sqlite` under WAL journaling — page-level writes and crash safety are properties of the storage engine itself. It still acquires a PID-stamped lock file beside the database on `open()`, released on `close()`, so a second opener gets a clear, immediate error rather than discovering the trust-boundary problem the hard way. A stale lock (owning process no longer alive) is reclaimed automatically, and an explicit override is available for the rare case of PID reuse.
- **`record-adapter-do-sqlite`** (Cloudflare Durable Objects, SQLite storage) needs no lock file at all — a Durable Object id maps to exactly one running instance, enforced by the platform itself, so the single-writer rule is a property of the runtime rather than something this adapter has to implement. There is likewise no `persist`/flush step: every write through `ctx.storage.sql` is durable by the time the call returns. The one real engine-specific wrinkle is transactions — DO SQLite rejects raw `BEGIN`/`COMMIT`/`ROLLBACK` outright, and (confirmed against the real runtime, not assumed) does not roll back a write on a later exception the way an open SQL transaction would; the adapter reaches `ctx.storage.transactionSync()` instead, through `SqlExecutor.transaction()` (see above).
- **The planned whole-file `adapter-json`** reads its entire store into memory on open and rewrites it whole on every persist, so it must supply both guarantees itself: a PID lock file (to fail loudly on double-open) and an atomic temp-file-and-`rename()` persist (so a crash mid-write can't leave a torn, unreadable file). `record-adapter-sqlite` gets both from WAL and real file locking instead.

## Lifecycle

**`Stack.close()` flushes, then releases.** Teardown is one call: `close()` invokes `flush()` before `adapter.close?.()`, so no app has to know whether its adapter buffers writes. An adapter's own `close()` is therefore not required to be flush-inclusive — the ordering is an invariant of the `Stack` layer, guaranteed once for every backend rather than reimplemented per adapter.

A failed flush still releases resources before the error propagates. The alternative — abandoning `close()` on a flush error — leaves a lock file or a connection behind precisely when the stack is in trouble, turning one failure into two.

**`close()` is idempotent; calling it twice is a no-op and never reaches the adapter twice.** Adapters are not independently required to tolerate a double close (`node:sqlite` throws on an already-closed handle, and lock release is not re-entrant), so `Stack` absorbs it.

**`flush()` alone is for a stack that stays open** — checkpointing before a backup, or forcing a buffered adapter to persist at a known point. It is not part of teardown.

**Every other method throws `UseAfterCloseError` once closed**, on both `Stack` and `ScopedStack`. Without the guard the failure surfaces as whatever the underlying engine says about a dangling handle — `node:sqlite`'s `ERR_INVALID_STATE`, or nothing at all on an adapter that silently accepts writes it will never persist. The asymmetry with `close()` is deliberate: teardown is idempotent because a caller cannot always know whether it already ran, while doing _work_ through a closed client is unambiguously a bug, and `flush()` is work.

`UseAfterCloseError` sits outside the `StackError` taxonomy (see [Wire format § The taxonomy root](./wire-format.md#the-taxonomy-root)). Every `StackError` maps to a wire status, and no server ever answers "your client is closed" — it is a local programming error, not a transportable failure. The stack-identity getters (`ownerEntityId`, `timezone`, `capabilities`) keep working after close: they read values cached at open and touch no storage.
