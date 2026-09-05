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

const record = await NativeSQLiteRecordAdapter.initialize({ path, entityId, timezone });
const blob = new S3BlobAdapter({ bucket: 'my-bucket' });
const adapter = combineAdapters({ record, blob });
const stack = await Stack.create(adapter);
```

`limits.attachmentBytes` lives on `AdapterCapabilities` (below), which `combineAdapters()` always reads from the `record` half — a blob-only package like `blob-adapter-s3` has no ceiling of its own to declare. Whichever `StackRecordAdapter` it's paired with should keep declaring `null`, per the local-adapter rule above: a blob adapter isn't the wire boundary that would justify one. Point `S3BlobAdapter` at Cloudflare R2 or another S3-compatible store by passing `endpoint` and `forcePathStyle: true`.

All adapters support the full Record API. Performance guarantees differ; correctness does not.

**`@haverstack/sqlite-shared`** is an internal, non-public package holding everything a SQLite-backed record adapter needs that isn't specific to one binding — schema DDL, `WHERE`/`ORDER` building, the cursor codec, row mappers, the FTS5 sanitizer and indexing strategy, the storage-ownership lock, and (via a small `SqlExecutor` interface normalizing a binding's call convention) the actual CRUD/query/version/type/association/token logic itself. An adapter implements only what's genuinely engine-specific: database construction, pragma setup, transaction semantics, and lifecycle. `record-adapter-sqlite` and `record-adapter-do-sqlite` both consume it; the split exists so a second (and third) SQLite engine inherits the behavior rather than reimplementing it, and so a cursor minted by one is decodable by another.

**It exposes two entry points.** The full barrel (`.`) includes the token-store logic (`SharedTokenLogic`, `TOKENS_SCHEMA_SQL`) and the file-lock helpers, both Node-specific (`node:crypto`, `node:fs`) — fine for `record-adapter-sqlite`, but a bare `import` of either survives tree-shaking as a dead-but-still-imported module in a bundle, which throws at load time in a Workers runtime without `nodejs_compat`. A record-only consumer with no token store and no lock file — `record-adapter-do-sqlite`, where the platform's single-writer-per-id model already is the lock — imports the `./record` subpath instead, which never reaches either.

**It is bundled into its consumers rather than published.** "Non-public" is enforced, not merely intended: the package is `private`, and its consumers inline it at build time, so installing one of them from the registry never resolves `@haverstack/sqlite-shared` and cannot depend on it. `SqlExecutor` and the `Shared*Logic` classes are therefore internal collaborators of the adapters in this repository, not an extension point — a second SQLite engine inherits them by living here, not by installing them. Reversing that (publishing it so third-party adapters can build on `SqlExecutor`) is a deliberate decision to make it public API with the stability obligations that implies, not a packaging tweak.

`SqlExecutor` is synchronous. Every SQLite binding in scope executes queries in-process without yielding, and the shared logic's explicit transaction boundaries (`SqlExecutor.transaction(fn)`) depend on that — an engine reached over a network (D1, libsql over HTTP) does not fit this interface without making it async throughout. `transaction(fn)` — not raw `BEGIN`/`COMMIT`/`ROLLBACK` strings — is the interface's transaction primitive specifically because it isn't universal SQL text: `record-adapter-sqlite` implements it as literal `BEGIN`/`COMMIT`/`ROLLBACK` around `fn()`, while `record-adapter-do-sqlite` implements it as `ctx.storage.transactionSync(fn)`, because Durable Object SQLite storage rejects raw multi-statement transaction SQL outright and does not auto-commit-then-roll-back on a later exception — verified against the real Workers runtime, not assumed. A binding that only had the three raw statements to work with couldn't reach that primitive at all.

SQLite-backed adapters enable foreign-key enforcement (`PRAGMA foreign_keys = ON`) so that operations like `associate()` against a nonexistent record fail loudly (`StackNotFoundError`) instead of silently creating an orphan row.

**File compatibility:** the adapter produces a standard SQLite file with an FTS5 `records_fts` index. Any adapter reading it needs FTS5, not merely SQLite.

## Adapter capabilities

Adapters expose a capabilities object so apps can check what's supported before relying on a feature:

```ts
type AdapterCapabilities = {
  filter: {
    content: 'none' | 'field' | 'path'; // how far a content filter key may reach
    contentPresent: boolean; // filter.contentPresent is honored
    search: boolean; // filter.search is honored
  };
  sort: {
    fields: ('createdAt' | 'updatedAt' | 'version')[]; // native columns this adapter can order by
    contentField: boolean; // sort.contentField is honored
  };
  limits: {
    attachmentBytes: number | null; // upload size ceiling, or null = client can't pre-check
    contentBytes: number | null; // record content/patch size ceiling, same reading of null
  };
};
```

`AdapterCapabilities` is the adapter-implementer-facing name. On the `StackClient` interface it is exposed as `features: StackFeatures` (a type alias for `AdapterCapabilities`). App and plugin code should read `stack.features` rather than going through the adapter directly.

**Each entry is named for the query key it answers for.** `filter.content` gates `filter.content`, `sort.fields` gates `sort.field`, and so on down — so the capability a query needs is derivable from the query rather than memorized, and an error can name the key to look at. `limits` is grouped apart because a ceiling is not a feature to gate on: nothing is refused for lacking one.

**`filter.content` is a ladder, not a set of flags.** The rungs nest — `'path'` is `'field'` plus traversal — so they are one ordered value, which is what keeps "traverses paths but matches no field names" out of the type entirely. A single-segment key (`'did'`) needs `'field'`; a multi-segment key (`'emails.value'`) needs `'path'`. The rungs are separate because a foreign server declaring field matching is promising to match a field _name_, and reading that as a promise to walk a path would hand its client an unfiltered superset presented as a filtered result.

**`'path'` is required for local adapters, and any rung is legitimate for a wire adapter.** "Local" means an adapter that reads/writes its storage in-process, with no network hop to a server that could have its own opinion — `record-adapter-sqlite`, `record-adapter-do-sqlite` (a Durable Object's storage is in-process from that DO's own point of view, even though the DO itself is reached over the network), any future JSON-file adapter, and first-party test doubles standing in for one. For storage a local adapter already owns and reads directly, filtering by `content` is a linear scan over resident data and traversal is the same scan with a deeper predicate — there's no architectural reason to stop short, so a shallower rung is never legitimate there. A remote server reached through `adapter-api` is the one legitimate case: native fields (`typeId`, `parentId`, `entityId`, dates) are a fixed, indexable schema every server needs anyway, but `content` is an arbitrary, app-defined JSON blob, and a server serving many stacks may reasonably decline to index or full-scan it.

`Stack.query()` enforces this before dispatching — see [Capability-gated filters](./data-model.md#capability-gated-filters). That check is a backstop for the rule above, not a substitute for it: a local adapter that (incorrectly) declared `'none'` would otherwise return an unfiltered superset for every `content` query.

**`filter.contentPresent` sits beside the ladder rather than on it.** It gates `filter.contentPresent`, and is required `true` for local adapters on the same reasoning: asking whether a path holds a value is the same walk with a weaker predicate. It is not a rung because a server promising to match a content value has not thereby promised to answer whether one is there at all. It is meaningful only above `'none'` — presence travels in the `POST /records/query` body, which a server reaching no content does not expose — and a presence path is itself gated by the rung, so a multi-segment one needs `'path'`.

**`filter.search` has no local-required rule.** A full-text index is a different mechanism from field matching, and neither implies the other, so a local adapter may legitimately decline it (see the JSON adapter note below).

**`sort.contentField` is a boolean, and `sort.fields` names native columns only.** Content fields are app-defined and unbounded, so an adapter cannot enumerate them; and an adapter that indexes content for sorting indexes [every top-level scalar](./data-model.md#sorting-by-a-content-field), so there is nothing per-field left to declare. `sort.contentField` is required `true` for local adapters, and independent of `filter.content`: the two describe ordering and filtering, and a server may offer either without the other — filtering is answerable at whatever scale a server already scans at, where ordering wants an index. Both are enforced: `Stack.query()` refuses a sort the adapter hasn't declared rather than letting it be answered in some other order, which a caller reading one bounded page cannot detect.

**Absent, malformed or unrecognized reads as the least capable value it could stand for.** One rule, for every entry: `'none'` for the reach, `false` for a flag, nothing for `sort.fields`, `null` for a limit. A discovery response that omits a group, omits `capabilities` entirely, or names a reach this client has never heard of describes a server this client will not send that query to — silence is never a claim, in either direction, and an unrecognized rung places nowhere on a ladder so it can only be read as its bottom. `normalizeCapabilities()` in `@haverstack/wire-types` applies the rule, so a client reads a foreign discovery response through one function rather than defaulting keys at each use.

Two things this does not refuse. A query naming no sort asks for the server's own default order rather than a stated one, so it claims nothing that has to be declared and runs against an empty `sort.fields`. And a `null` limit is permissive by design: it says this client cannot pre-check, not that nothing is enforced — the server's own ceiling still answers with a `413`.

**Per-adapter notes:**

- **JSON adapter** — supports all filter fields via O(n) scan; may maintain `_index.json` to speed up native field lookups; `filter.search: false` in v1 (local adapters may decline search; `filter.content: 'path'` is the required one)
- **Native SQLite adapter** (`record-adapter-sqlite`) — indexes all native fields and association labels; supports content field queries and full-text search via FTS5
- **Durable Object SQLite adapter** (`record-adapter-do-sqlite`) — same capabilities as the native SQLite adapter (shares `SharedSqlRecordLogic`); DO's SQLite storage ships FTS5
- **API adapter** — capabilities determined by the server; declared in a discovery endpoint; the one adapter kind allowed to declare a `filter.content` rung below `'path'`

Local, embedded adapters (JSON, native SQLite, Durable Object SQLite) declare both limits `null` — nothing at the storage layer imposes a ceiling, and a caller with in-process access to the database can spend its own memory however it likes. Only a server behind the API adapter declares one, since it's the only adapter carrying bytes over a connection with its own limits.

**`limits.attachmentBytes` bounds an upload; `limits.contentBytes` bounds the JSON side of a write** — the serialized size of a Record's `content` on create, or of a merge patch on update. A server declares its request-size limit as the latter, and `Stack.create()`/`Stack.update()` pre-check against it and throw `StackPayloadTooLargeError` before sending — the same client-side courtesy `putAttachment()` extends for attachments, with the server's own limit still authoritative (see [Wire format § Request size limits](./wire-format.md#request-size-limits)).

## Concurrency & storage ownership

A stack's backing storage (a SQLite file, a JSON directory) has exactly one owning process at a time. Multi-app access goes through a server implementation over the wire protocol (`adapter-api`, against `localhost` or a hosted provider) — never by pointing multiple apps at the same storage file directly. This is also the only topology in which permissions, grants, and `appId` attribution mean anything: `Stack` performs no permission checks, `ScopedStack` is opt-in, and `appId` is self-reported by the writing app, so direct storage access implies full trust over everything in the store, including grants and token hashes.

How each adapter honors the single-writer rule differs by what it actually is:

- **`record-adapter-sqlite`** (Node, real files) writes through `node:sqlite` under WAL journaling — page-level writes and crash safety are properties of the storage engine itself. It still acquires a PID-stamped lock file beside the database on `open()`/`initialize()`, released on `close()`, so a second opener gets a clear, immediate error rather than discovering the trust-boundary problem the hard way. A stale lock (owning process no longer alive) is reclaimed automatically, and an explicit override is available for the rare case of PID reuse.
- **`record-adapter-do-sqlite`** (Cloudflare Durable Objects, SQLite storage) needs no lock file at all — a Durable Object id maps to exactly one running instance, enforced by the platform itself, so the single-writer rule is a property of the runtime rather than something this adapter has to implement. There is likewise no `persist`/flush step: every write through `ctx.storage.sql` is durable by the time the call returns. The one real engine-specific wrinkle is transactions — DO SQLite rejects raw `BEGIN`/`COMMIT`/`ROLLBACK` outright, and (confirmed against the real runtime, not assumed) does not roll back a write on a later exception the way an open SQL transaction would; the adapter reaches `ctx.storage.transactionSync()` instead, through `SqlExecutor.transaction()` (see above).
- **The planned whole-file `adapter-json`** reads its entire store into memory on open and rewrites it whole on every persist, so it must supply both guarantees itself: a PID lock file (to fail loudly on double-open) and an atomic temp-file-and-`rename()` persist (so a crash mid-write can't leave a torn, unreadable file). `record-adapter-sqlite` gets both from WAL and real file locking instead.

## Lifecycle

**`Stack.close()` flushes, then releases.** Teardown is one call: `close()` invokes `flush()` before `adapter.close?.()`, so no app has to know whether its adapter buffers writes. An adapter's own `close()` is therefore not required to be flush-inclusive — the ordering is an invariant of the `Stack` layer, guaranteed once for every backend rather than reimplemented per adapter.

A failed flush still releases resources before the error propagates. The alternative — abandoning `close()` on a flush error — leaves a lock file or a connection behind precisely when the stack is in trouble, turning one failure into two.

**`close()` is idempotent; calling it twice is a no-op and never reaches the adapter twice.** Adapters are not independently required to tolerate a double close (`node:sqlite` throws on an already-closed handle, and lock release is not re-entrant), so `Stack` absorbs it.

**`flush()` alone is for a stack that stays open** — checkpointing before a backup, or forcing a buffered adapter to persist at a known point. It is not part of teardown.

**Every other method throws `StackClosedError` once closed**, on both `Stack` and `ScopedStack`. Without the guard the failure surfaces as whatever the underlying engine says about a dangling handle — `node:sqlite`'s `ERR_INVALID_STATE`, or nothing at all on an adapter that silently accepts writes it will never persist. The asymmetry with `close()` is deliberate: teardown is idempotent because a caller cannot always know whether it already ran, while doing _work_ through a closed client is unambiguously a bug, and `flush()` is work.

`StackClosedError` sits outside the `StackError` taxonomy, alongside `IdGenerationError` and `InvalidDidError` (see [Wire format § The taxonomy root](./wire-format.md#the-taxonomy-root)). Every `StackError` maps to a wire status, and no server ever answers "your client is closed" — it is a local programming error, not a transportable failure. The stack-identity getters (`ownerEntityId`, `timezone`, `features`) keep working after close: they read values cached at open and touch no storage.
