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

| Package                 | Type   | Use case                                                 |
| ----------------------- | ------ | -------------------------------------------------------- |
| `adapter-local`         | full   | Local app storage — native SQLite + disk blobs           |
| `record-adapter-sqlite` | record | Node native SQLite (`node:sqlite`) records, FTS5, WAL    |
| `record-adapter-sqljs`  | record | Browser-only sql.js records, FTS4, pluggable persistence |
| `blob-adapter-disk`     | blob   | Content-addressed blobs on disk                          |
| `adapter-api`           | full   | Hosted/shared stacks via HTTP                            |
| `adapter-json`          | full   | Portable JSON files _(planned)_                          |

`adapter-local` is the batteries-included package for the common local case. It wraps `NativeSQLiteRecordAdapter` and `DiskBlobAdapter` and stores attachments in an `attachments/` subdirectory next to the database file. Bearer tokens, when used, live in a separate sibling file (`<path>.tokens`, via `NativeTokenStore`) — never inside the portable stack database.

Use `combineAdapters()` from `@haverstack/core` when you want different backends for records and blobs — for example, native SQLite records with S3 blob storage:

```ts
import { combineAdapters } from '@haverstack/core';
import { NativeSQLiteRecordAdapter } from '@haverstack/record-adapter-sqlite';
import { S3BlobAdapter } from '@haverstack/blob-adapter-s3'; // hypothetical

const record = await NativeSQLiteRecordAdapter.initialize({ path, entityId, timezone });
const blob = new S3BlobAdapter(bucketConfig);
const adapter = combineAdapters({ record, blob });
const stack = await Stack.create(adapter);
```

All adapters support the full Record API. Performance guarantees differ; correctness does not.

**`@haverstack/sqlite-shared`** is an internal, non-public package holding everything identical across the two SQLite-backed record adapters — schema DDL, `WHERE`/`ORDER` building, the cursor codec, row mappers, both FTS sanitizers, the storage-ownership lock, and (via a small `SqlExecutor` interface normalizing sql.js's and `node:sqlite`'s different call conventions) the actual CRUD/query/version/type/association/token logic itself. Each adapter implements only what's genuinely engine-specific: WASM init vs. `DatabaseSync` construction, pragma/WAL setup, and lifecycle. Keeping this in one place is what keeps a cursor minted by one SQLite-backed adapter decodable by another, and what keeps the two engines from silently drifting in behavior.

Both SQLite-backed adapters enable foreign-key enforcement (`PRAGMA foreign_keys = ON`) so that operations like `associate()` against a nonexistent record fail loudly (`StackNotFoundError`) instead of silently creating an orphan row.

**File compatibility:** both adapters produce standard SQLite files, so `record-adapter-sqlite` can open a stack created by `record-adapter-sqljs` — `open()` detects an FTS4 `records_fts` table (sqljs's dialect) and transparently rebuilds it as FTS5, once.

## Adapter capabilities

Adapters expose a capabilities object so apps can check what's supported before relying on a feature:

```ts
type AdapterCapabilities = {
  fullTextSearch: boolean;
  contentFieldQuery: boolean;
  sortableFields: string[];
  maxAttachmentBytes: number | null; // upload size ceiling, or null = unbounded
};
```

`AdapterCapabilities` is the adapter-implementer-facing name. On the `StackClient` interface it is exposed as `features: StackFeatures` (a type alias for `AdapterCapabilities`). App and plugin code should read `stack.features` rather than going through the adapter directly.

**`contentFieldQuery` is required-`true` for local adapters, optional and discovery-driven for wire adapters.** "Local" means an adapter that reads/writes its storage in-process, with no network hop to a server that could have its own opinion — `record-adapter-sqlite`, `record-adapter-sqljs`, any future JSON-file adapter, and first-party test doubles standing in for one. For storage a local adapter already owns and reads directly, filtering by `content` is just a linear scan over resident data — there's no architectural reason a local adapter can't support it, so declaring `false` is never legitimate there. A remote server reached through `adapter-api` is the one legitimate `false` case: native fields (`typeId`, `parentId`, `entityId`, dates) are a fixed, indexable schema every server needs anyway, but `content` is an arbitrary, app-defined JSON blob, and a server serving many stacks may reasonably decline to index or full-scan it. `fullTextSearch` has no such local-required rule — a local adapter may legitimately decline it (see the JSON adapter note below).

`Stack.query()` enforces this before dispatching — see [Capability-gated filters](./data-model.md#capability-gated-filters). That check is a backstop for the rule above, not a substitute for it: a local adapter that (incorrectly) declared `false` would otherwise return an unfiltered superset for every `content` query.

**Per-adapter notes:**

- **JSON adapter** — supports all filter fields via O(n) scan; may maintain `_index.json` to speed up native field lookups; `fullTextSearch: false` in v1 (local adapters may decline `fullTextSearch`; only `contentFieldQuery` is required-`true`)
- **Native SQLite adapter** (`record-adapter-sqlite`) — indexes all native fields and association labels; supports content field queries and full-text search via FTS5
- **sql.js adapter** (`record-adapter-sqljs`, browser-only) — same query support as the native adapter, but full-text search via FTS4 (the sql.js WASM build's dialect)
- **API adapter** — capabilities determined by the server; declared in a discovery endpoint; the one adapter kind allowed to declare `contentFieldQuery: false`

Local, embedded adapters (JSON, native SQLite, sql.js) declare `maxAttachmentBytes: null` — nothing at the storage layer imposes a ceiling. Only a server behind the API adapter enforces one, since it's the only adapter transporting attachment bytes over a connection with its own limits.

## Concurrency & storage ownership

A stack's backing storage (a SQLite file, a JSON directory) has exactly one owning process at a time. Multi-app access goes through a server implementation over the wire protocol (`adapter-api`, against `localhost` or a hosted provider) — never by pointing multiple apps at the same storage file directly. This is also the only topology in which permissions, grants, and `appId` attribution mean anything: `Stack` performs no permission checks, `ScopedStack` is opt-in, and `appId` is self-reported by the writing app, so direct storage access implies full trust over everything in the store, including grants and token hashes.

How each adapter honors the single-writer rule differs by what it actually is:

- **`record-adapter-sqlite`** (Node, real files) writes through `node:sqlite` under WAL journaling — page-level writes and crash safety are properties of the storage engine itself. It still acquires a PID-stamped lock file beside the database on `open()`/`initialize()`, released on `close()`, so a second opener gets a clear, immediate error rather than discovering the trust-boundary problem the hard way. A stale lock (owning process no longer alive) is reclaimed automatically, and an explicit override is available for the rare case of PID reuse.
- **`record-adapter-sqljs`** (browser, no filesystem of its own) is a purely in-memory engine — no file, no PID, no lock to speak of. Durability and multi-tab/multi-process coordination are the embedding host's concern entirely: the adapter calls an optional `persist(bytes) => Promise<void>` callback after every write, and the host wires that to OPFS, IndexedDB, or a download, with whatever locking that storage layer provides.
- **The planned whole-file `adapter-json`** reads its entire store into memory on open and rewrites it whole on every persist, so it must supply both guarantees itself: a PID lock file (to fail loudly on double-open) and an atomic temp-file-and-`rename()` persist (so a crash mid-write can't leave a torn, unreadable file). `record-adapter-sqlite` gets both from WAL and real file locking instead.
