# Adapters

## Interface split

The adapter contract is split into two focused interfaces that are composed into a single `StackAdapter`:

**`StackRecordAdapter`** — structured storage: capabilities, stack identity (`ownerEntityId`, `timezone`), all record/association/version/type methods, and optional lifecycle hooks (`flush`, `close`).

**`StackBlobAdapter`** — binary storage: `putAttachment`, `getAttachment`, `deleteAttachment`, an optional `listFiles()` capability, and optional lifecycle hooks.

**`StackBlobAdapter` error contract:** `getAttachment(fileId)` throws `StackNotFoundError` when no blob exists for `fileId`, and `StackQueryError` when `fileId` itself is malformed (not a 64-character lowercase hex string) — the same two conditions the wire format reports as 404 and 400, so an app written against a local adapter and one written against the API adapter can `instanceof`-check the same classes. Implementations must not return empty/placeholder bytes for an absent fileId.

```ts
type StackAdapter = StackRecordAdapter &
  StackBlobAdapter & {
    // Optional: bytes + _attachment@1 record as one atomic operation
    putAttachmentWithMetadata?(
      data: Uint8Array,
      mimeType: string,
      filename?: string,
    ): Promise<StackRecord>;
  };
```

**Optional capabilities** follow one pattern throughout: an optional interface method, checked for truthiness at the call site, with a described fallback when absent. `StackRecordAdapter.deleteUnreferencedAttachmentRecords()` (atomic reference check — see [Attachments](./attachments.md#deleting-attachments)), `StackBlobAdapter.listFiles()` (blob enumeration, used by [garbage collection](./attachments.md#garbage-collection) to find bare-bytes orphans), and `StackAdapter.putAttachmentWithMetadata()` (atomic upload, below) are all this shape — no boolean flag in `capabilities`, just an optional method a caller checks for before using. `combineAdapters()` (below) preserves this: it forwards an optional method only when the underlying part actually implements it, never as a wrapper around a missing one.

`StackAdapter.putAttachmentWithMetadata(data, mimeType, filename?)` stores bytes and creates the accompanying `_attachment@1` record as **one atomic operation**, returning the created record. It is declared on the composed `StackAdapter` type rather than on either half, because neither half can ever have it: "bytes + record in one operation" is a property only a whole adapter can offer. Today exactly one does: the API adapter, backed by a single `POST /attachments` request the server fulfills atomically. Local storage adapters don't implement it, and `combineAdapters()` never synthesizes it from parts (a record backend and a blob backend glued together have no shared transaction). `Stack.putAttachment()` checks for it — present means delegate the whole operation and trust the returned record as backend-authoritative; absent means the bytes-then-`create()` fallback sequence. See [Wire format § Attachments](./wire-format.md#attachments) for why the atomic form is a correctness requirement, not an efficiency optimization.

## Package naming convention

Packages follow a naming convention that makes the adapter type discoverable:

- **`adapter-*`** — full `StackAdapter` (convenience packages covering both halves)
- **`record-adapter-*`** — `StackRecordAdapter` only
- **`blob-adapter-*`** — `StackBlobAdapter` only

## Adapter backends

| Package                 | Type   | Use case                                              |
| ----------------------- | ------ | ----------------------------------------------------- |
| `adapter-local`         | full   | Local app storage — native SQLite + disk blobs        |
| `record-adapter-sqlite` | record | Node native SQLite (`node:sqlite`) records, FTS5, WAL |
| `blob-adapter-disk`     | blob   | Content-addressed blobs on disk                       |
| `adapter-api`           | full   | Hosted/shared stacks via HTTP                         |
| `adapter-json`          | full   | Portable JSON files _(planned)_                       |

`adapter-local` is the batteries-included package for the common local case. It wraps `NativeSQLiteRecordAdapter` and `DiskBlobAdapter` and stores attachments in an `attachments/` subdirectory next to the database file. Bearer tokens, when used, live in a separate sibling file (`<path>.tokens`, via `NativeTokenStore`) — never inside the portable stack database.

Use `combineAdapters()` from `@haverstack/core/adapter` when you want different backends for records and blobs — for example, native SQLite records with S3 blob storage:

```ts
import { combineAdapters } from '@haverstack/core/adapter';
import { NativeSQLiteRecordAdapter } from '@haverstack/record-adapter-sqlite';
import { S3BlobAdapter } from '@haverstack/blob-adapter-s3'; // hypothetical

const record = await NativeSQLiteRecordAdapter.initialize({ path, entityId, timezone });
const blob = new S3BlobAdapter(bucketConfig);
const adapter = combineAdapters({ record, blob });
const stack = await Stack.create(adapter);
```

All adapters support the full Record API. Performance guarantees differ; correctness does not.

**`@haverstack/sqlite-shared`** is an internal, non-public package holding everything a SQLite-backed record adapter needs that isn't specific to one binding — schema DDL, `WHERE`/`ORDER` building, the cursor codec, row mappers, the FTS5 sanitizer and indexing strategy, the storage-ownership lock, and (via a small `SqlExecutor` interface normalizing a binding's call convention) the actual CRUD/query/version/type/association/token logic itself. An adapter implements only what's genuinely engine-specific: database construction, pragma/WAL setup, and lifecycle. `record-adapter-sqlite` is its only consumer today; the split exists so a second SQLite engine inherits the behavior rather than reimplementing it, and so a cursor minted by one is decodable by another.

`SqlExecutor` is synchronous. Every SQLite binding in scope executes queries in-process without yielding, and the shared logic's explicit `BEGIN`/`COMMIT` sequences depend on that — an engine reached over a network (D1, libsql over HTTP) does not fit this interface without making it async throughout.

SQLite-backed adapters enable foreign-key enforcement (`PRAGMA foreign_keys = ON`) so that operations like `associate()` against a nonexistent record fail loudly (`StackNotFoundError`) instead of silently creating an orphan row.

**File compatibility:** the adapter produces a standard SQLite file with an FTS5 `records_fts` index. Any adapter reading it needs FTS5, not merely SQLite.

## Adapter capabilities

Adapters expose a capabilities object so apps can check what's supported before relying on a feature:

```ts
type AdapterCapabilities = {
  fullTextSearch: boolean;
  contentFieldQuery: boolean;
  sortableFields: string[];
  maxAttachmentBytes: number | null; // upload size ceiling, or null = unbounded
  maxContentBytes: number | null; // record content/patch size ceiling, or null = unbounded
};
```

`AdapterCapabilities` is the adapter-implementer-facing name. On the `StackClient` interface it is exposed as `features: StackFeatures` (a type alias for `AdapterCapabilities`). App and plugin code should read `stack.features` rather than going through the adapter directly.

**`contentFieldQuery` is required-`true` for local adapters, optional and discovery-driven for wire adapters.** "Local" means an adapter that reads/writes its storage in-process, with no network hop to a server that could have its own opinion — `record-adapter-sqlite`, any future JSON-file adapter, and first-party test doubles standing in for one. For storage a local adapter already owns and reads directly, filtering by `content` is just a linear scan over resident data — there's no architectural reason a local adapter can't support it, so declaring `false` is never legitimate there. A remote server reached through `adapter-api` is the one legitimate `false` case: native fields (`typeId`, `parentId`, `entityId`, dates) are a fixed, indexable schema every server needs anyway, but `content` is an arbitrary, app-defined JSON blob, and a server serving many stacks may reasonably decline to index or full-scan it. `fullTextSearch` has no such local-required rule — a local adapter may legitimately decline it (see the JSON adapter note below).

`Stack.query()` enforces this before dispatching — see [Capability-gated filters](./data-model.md#capability-gated-filters). That check is a backstop for the rule above, not a substitute for it: a local adapter that (incorrectly) declared `false` would otherwise return an unfiltered superset for every `content` query.

**Per-adapter notes:**

- **JSON adapter** — supports all filter fields via O(n) scan; may maintain `_index.json` to speed up native field lookups; `fullTextSearch: false` in v1 (local adapters may decline `fullTextSearch`; only `contentFieldQuery` is required-`true`)
- **Native SQLite adapter** (`record-adapter-sqlite`) — indexes all native fields and association labels; supports content field queries and full-text search via FTS5
- **API adapter** — capabilities determined by the server; declared in a discovery endpoint; the one adapter kind allowed to declare `contentFieldQuery: false`

Local, embedded adapters (JSON, native SQLite) declare `maxAttachmentBytes: null` — nothing at the storage layer imposes a ceiling. Only a server behind the API adapter enforces one, since it's the only adapter transporting attachment bytes over a connection with its own limits.

**`maxContentBytes` is the same field for the JSON side of a write** — the serialized size of a Record's `content` on create, or of a merge patch on update. Local adapters declare `null` for the same reason: a caller with in-process access to the database can spend its own memory however it likes, and nothing at the storage layer objects. A server declares its request-size limit here, and `Stack.create()`/`Stack.update()` pre-check against it and throw `StackPayloadTooLargeError` before sending — the same client-side courtesy `putAttachment()` extends for attachments, with the server's own limit still authoritative (see [Wire format § Request size limits](./wire-format.md#request-size-limits)).

## Concurrency & storage ownership

A stack's backing storage (a SQLite file, a JSON directory) has exactly one owning process at a time. Multi-app access goes through a server implementation over the wire protocol (`adapter-api`, against `localhost` or a hosted provider) — never by pointing multiple apps at the same storage file directly. This is also the only topology in which permissions, grants, and `appId` attribution mean anything: `Stack` performs no permission checks, `ScopedStack` is opt-in, and `appId` is self-reported by the writing app, so direct storage access implies full trust over everything in the store, including grants and token hashes.

How each adapter honors the single-writer rule differs by what it actually is:

- **`record-adapter-sqlite`** (Node, real files) writes through `node:sqlite` under WAL journaling — page-level writes and crash safety are properties of the storage engine itself. It still acquires a PID-stamped lock file beside the database on `open()`/`initialize()`, released on `close()`, so a second opener gets a clear, immediate error rather than discovering the trust-boundary problem the hard way. A stale lock (owning process no longer alive) is reclaimed automatically, and an explicit override is available for the rare case of PID reuse.
- **The planned whole-file `adapter-json`** reads its entire store into memory on open and rewrites it whole on every persist, so it must supply both guarantees itself: a PID lock file (to fail loudly on double-open) and an atomic temp-file-and-`rename()` persist (so a crash mid-write can't leave a torn, unreadable file). `record-adapter-sqlite` gets both from WAL and real file locking instead.

## Lifecycle

**`Stack.close()` flushes, then releases.** Teardown is one call: `close()` invokes `flush()` before `adapter.close?.()`, so no app has to know whether its adapter buffers writes. An adapter's own `close()` is therefore not required to be flush-inclusive — the ordering is an invariant of the `Stack` layer, guaranteed once for every backend rather than reimplemented per adapter.

A failed flush still releases resources before the error propagates. The alternative — abandoning `close()` on a flush error — leaves a lock file or a connection behind precisely when the stack is in trouble, turning one failure into two.

**`close()` is idempotent; calling it twice is a no-op and never reaches the adapter twice.** Adapters are not independently required to tolerate a double close (`node:sqlite` throws on an already-closed handle, and lock release is not re-entrant), so `Stack` absorbs it.

**`flush()` alone is for a stack that stays open** — checkpointing before a backup, or forcing a buffered adapter to persist at a known point. It is not part of teardown.

**Every other method throws `StackClosedError` once closed**, on both `Stack` and `ScopedStack`. Without the guard the failure surfaces as whatever the underlying engine says about a dangling handle — `node:sqlite`'s `ERR_INVALID_STATE`, or nothing at all on an adapter that silently accepts writes it will never persist. The asymmetry with `close()` is deliberate: teardown is idempotent because a caller cannot always know whether it already ran, while doing _work_ through a closed client is unambiguously a bug, and `flush()` is work.

`StackClosedError` sits outside the `StackError` taxonomy, alongside `IdGenerationError` and `InvalidDidError` (see [Wire format § The taxonomy root](./wire-format.md#the-taxonomy-root)). Every `StackError` maps to a wire status, and no server ever answers "your client is closed" — it is a local programming error, not a transportable failure. The stack-identity getters (`ownerEntityId`, `timezone`, `features`) keep working after close: they read values cached at open and touch no storage.
