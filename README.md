# Haverstack

A portable personal data stack. Take your data with you.

Haverstack is a structured data store for individuals and small organizations. Apps write **Records** into your **stack** — and the stack handles storage, querying, versioning, and permissions, regardless of where data actually lives.

> **Status:** Early development. APIs are unstable.

---

## What is a stack?

A stack is a personal or organizational data store. It belongs to one **Entity** (a person or org) and holds **Records** — structured data objects that apps create and read.

The key idea: apps talk to the Haverstack library, not to a storage format directly — switch backends without changing your app's data-access code. That said, storage ownership is exclusive: **a stack file is owned by exactly one process at a time.**

---

## How apps share a stack

- **One app, one stack:** the app embeds `adapter-local` and owns the file directly. This is the simple, common case.
- **Multiple apps, one stack:** run a server (local or hosted) that owns the file, and have each app connect through `adapter-api` — the same client works against `localhost` or a remote provider.

Don't point more than one app at the same stack file with `adapter-local`. Nothing enforces permissions at that layer — `appId` is self-reported and grants aren't checked — so direct file access is a full-trust, single-owner arrangement, not a way to share data between apps. See [Concurrency & storage ownership](./docs/spec/adapters.md#concurrency--storage-ownership) in the spec for the full rationale.

### Containing an app you don't fully trust

Through a server, an app you install can be given its own identity instead of running as you. It mints a `did:key` keypair, authenticates with it, and reaches only the types you grant it:

```ts
// One-time, from the owner's side: name the app, then grant it types.
await stack.create('_app@1', {
  appId: 'com.example.notesapp', // the software this card is about
  name: 'My Notes App',
  did: notesAppDid, // the keypair the app generated at install
});

await stack.grant(notesAppDid, [
  {
    typeId: 'com.example.myapp/note@1',
    actions: ['create', 'read-own', 'update-own', 'delete-own'],
  },
]);
```

The containment is the **type list**, not the `-own` suffix. When a delegated app acts for someone, `-own` is read as the bare verb and the subject decides which records are in reach — so in a personal stack, where nearly everything is owner-authored, `read-own` is close to `read-any`. Grant an app the types it needs and no more.

On the app's side, connecting is the keypair plus a URL. `APIAdapter` performs the challenge–response handshake on open and re-runs it whenever the token expires, so there is no token to obtain, store, or refresh by hand:

```ts
import { APIAdapter } from '@haverstack/adapter-api';
import { didCredentialFromKeypair } from '@haverstack/core';

const adapter = await APIAdapter.open({
  url: 'https://stack.example.com',
  credential: didCredentialFromKeypair(appKeypair), // or your own { did, sign }
  expectedOwner: ownerDid, // refuse a server claiming to be someone else's stack
});
```

`credential` is a **signing callback, not a private key** — key custody stays with the app, so it can be backed by a hardware key or a keychain prompt just as easily as by a keypair in memory.

Server-side, a token resolves to two identities, and when an app acts for a person rather than for itself the server names them both — authority becomes the intersection of what the app may do and what that person may do, while authorship stays with the person:

```ts
const session = await tokens.lookupToken(bearer); // { principalId, subjectId }
const scoped = stack.forSession(session);
```

The delegation itself — "this app acts for Bob" — is asserted by you when the token is issued, not by the app: proving key possession proves who the app _is_ and nothing about whom it may speak for. An app that could name its own subject would be choosing its own authority.

**You don't do this for software you didn't choose.** An app someone else uses to reach your stack — a visitor's own client posting a comment — authenticates as _them_, and is bounded by what you granted people, typically a default grant. You grant types to people, never to every client they might be running. See [Identity § App](./docs/spec/identity.md#app) for both postures and [Access control § Delegation](./docs/spec/access-control.md#delegation-principal-and-subject) for what each identity governs; the handshake itself is [Wire format § Authentication](./docs/spec/wire-format.md#authentication).

---

## Packages

This is a monorepo. Packages are published to npm under the `@haverstack` scope.

| Package                                                                 | Description                                                                       |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| [`@haverstack/core`](./packages/core)                                   | Stack class, types, schema, validation, ID generation                             |
| [`@haverstack/adapter-local`](./packages/adapter-local)                 | Local adapter (native SQLite + disk) — single-app/embedded or server use          |
| [`@haverstack/record-adapter-sqlite`](./packages/record-adapter-sqlite) | Node native SQLite (`node:sqlite`) `StackRecordAdapter` — used by `adapter-local` |
| [`@haverstack/record-adapter-sqljs`](./packages/record-adapter-sqljs)   | sql.js (SQLite/WASM) `StackRecordAdapter` — browser-only                          |
| [`@haverstack/blob-adapter-disk`](./packages/blob-adapter-disk)         | Disk filesystem `StackBlobAdapter`                                                |
| [`@haverstack/adapter-api`](./packages/adapter-api)                     | HTTP adapter for remote stack servers                                             |

Planned:

| Package                    | Description               |
| -------------------------- | ------------------------- |
| `@haverstack/adapter-json` | JSON file storage adapter |

---

## Quick start

```ts
import { Stack, generateDidKeypair } from '@haverstack/core';
import { LocalAdapter } from '@haverstack/adapter-local';

// First run — generate an identity keypair. `did` is a "did:key:z6Mk..."
// string derived from the public key — that's your entityId. Persist
// `privateKey` yourself somewhere safe (OS keychain, encrypted file, ...);
// the stack never stores it, only the public identity.
const { did, privateKey } = await generateDidKeypair();

const adapter = await LocalAdapter.initialize({
  path: './my-stack.db',
  entityId: did,
  timezone: 'America/New_York',
});

// Subsequent runs — open the existing stack
// const adapter = await LocalAdapter.open({ path: './my-stack.db' });

// ownerProfile creates your own _entity profile record on first run —
// safe to keep passing on every open, it's a no-op once the record exists.
const stack = await Stack.create(adapter, { ownerProfile: { name: 'Jane Smith' } });

// Define a type
await stack.defineType('com.example.myapp/note@1', 'Note', {
  text: { kind: 'text', required: true },
  title: { kind: 'string' },
});

// Create a record
const note = await stack.create('com.example.myapp/note@1', {
  text: 'Hello, Haverstack!',
  title: 'My first note',
});

// Update it (partial merge — only changed fields needed)
await stack.update(note.id, { title: 'Updated title' });

// Tag it
await stack.associate(note.id, { kind: 'tag', label: 'favourite' });

// Query
const notes = await stack.query({
  filter: { typeId: 'com.example.myapp/note@1', tags: ['favourite'] },
  sort: { field: 'createdAt', direction: 'desc' },
});

// Tear down when done (flushes pending writes and releases resources)
await stack.close();
```

---

## Core concepts

### Records

The fundamental unit of data. Every record has:

- A **Crockford base-32 ID** — time-sortable, human-readable, URL-safe
- A **type** — defined by the app that created it
- **Content** — a JSON object validated against the type's schema
- Optional: `parentId`, `entityId`, `appId`, `principalId`, `permissions`, `associations`

### Identity

`entityId` — on records, permissions, grants, group membership, the stack owner — is a [DID](https://www.w3.org/TR/did-core/) string, e.g. `did:key:z6Mk...`. An identity is a keypair; there's no provider, directory, or domain to trust. `did:key` (a public key, encoded — nothing else) is the mandatory floor; `generateDidKeypair()` mints one. Other DID methods (`did:web`, `did:plc`, ...) are valid `entityId` values too.

The `_entity` record type is a **local profile** about a DID, not the identity itself — a petname card (`{ did, name, handle? }`) with a display name you chose for that DID. Two stacks can hold different `_entity` cards with different names for the same DID; that's correct, it's each owner's own contact card. `Stack.create(adapter, { ownerProfile })` creates the owner's own card on first run.

See [Identity](./docs/spec/identity.md) in the spec for the full model, including authentication (challenge–response, not a shared secret) and what's deliberately deferred (key rotation).

### Types

Types define the schema for a record's content. They are identified by a **namespaced, versioned string**:

```
com.example.myapp/note@1
```

The app author controls the namespace. Two stacks running the same app have the same type IDs and can interop.

### Associations

Tags, attachments, and relationships are unified under a single model:

```ts
{ kind: 'tag',          label: 'favourite' }
{ kind: 'attachment',   label: 'avatar',   fileId: '...' }
{ kind: 'relationship', label: 'reply-to', recordId: '...' }
```

### Migrations

Types can evolve over time. Register migration functions between adjacent versions — the library composes them into chains automatically:

```ts
await stack.defineType(
  'com.example.myapp/note@2',
  'Note',
  {
    text: { kind: 'text', required: true },
    title: { kind: 'string', required: false },
  },
  { migratesFrom: 'com.example.myapp/note@1' },
);

stack.registerMigration({
  from: 'com.example.myapp/note@1',
  to: 'com.example.myapp/note@2',
  migrate: (content) => ({ ...content, title: '' }),
});
```

Migration is **lazy** — records are migrated in memory on read, and committed to disk the next time they are updated. Use `stack.migrateAll()` to commit eagerly.

### Adapters

The adapter interface is split into `StackRecordAdapter` (structured records) and `StackBlobAdapter` (binary files). Packages follow a naming convention that makes the type clear:

- **`adapter-*`** — full `StackAdapter` (convenience packages that cover both halves)
- **`record-adapter-*`** — `StackRecordAdapter` only
- **`blob-adapter-*`** — `StackBlobAdapter` only

| Package                 | Type   | Use case                                                                        |
| ----------------------- | ------ | ------------------------------------------------------------------------------- |
| `adapter-local`         | full   | Single-app/embedded or server use — native SQLite records + disk blobs          |
| `record-adapter-sqlite` | record | Node native SQLite (`node:sqlite`) records, FTS5, WAL — used by `adapter-local` |
| `record-adapter-sqljs`  | record | Browser-only sql.js (SQLite/WASM) records, FTS4 — pluggable persistence         |
| `blob-adapter-disk`     | blob   | Content-addressed blobs on the local filesystem                                 |
| `adapter-api`           | full   | Hosted/shared stacks via HTTP                                                   |
| `adapter-json`          | full   | Portable JSON files _(planned)_                                                 |

Use `combineAdapters({ record, blob })` from `@haverstack/core` to compose a record adapter with a different blob backend — for example, `NativeSQLiteRecordAdapter` with a future `S3BlobAdapter`. `adapter-local` wraps this pattern for the common case.

---

## Development

This repo uses [pnpm workspaces](https://pnpm.io/workspaces).

```sh
# Install dependencies
pnpm install

# Run all tests
pnpm test

# Build all packages
pnpm build

# Typecheck all packages (requires a build first — packages resolve
# each other through dist/*.d.ts)
pnpm typecheck
```

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the full pre-push checklist, comment and commit conventions, and the architecture conventions this codebase follows.

### Project structure

```
docs/
  spec.md                 # Design spec — overview and index
  spec/                   # Spec sub-documents — data model, identity, access control, wire format, …
packages/
  core/                   # @haverstack/core
    src/
      index.ts            # Public exports
      types.ts            # All type definitions (StackRecordAdapter, StackBlobAdapter, StackAdapter, …)
      stack.ts            # Stack class
      combine.ts          # combineAdapters() — compose record + blob adapters
      access.ts           # Permission and grant checking
      id.ts               # Crockford base-32 ID generation
      schema.ts           # Schema hashing and type compatibility
      validate.ts         # Content validation
      testing.ts          # MemoryAdapter test helper (@haverstack/core/testing)
    tests/
  adapter-local/          # @haverstack/adapter-local
    src/
      index.ts            # LocalAdapter (StackAdapter) — wraps record + blob adapters below
    tests/
  record-adapter-sqlite/  # @haverstack/record-adapter-sqlite
    src/
      index.ts            # NativeSQLiteRecordAdapter (StackRecordAdapter), node:sqlite
      token-store.ts       # NativeTokenStore (StackTokenStore), separate file from records
    tests/
  record-adapter-sqljs/  # @haverstack/record-adapter-sqljs
    src/
      index.ts            # SQLiteRecordAdapter (StackRecordAdapter) — browser-only, sql.js
    tests/
  blob-adapter-disk/      # @haverstack/blob-adapter-disk
    src/
      index.ts            # DiskBlobAdapter (StackBlobAdapter)
    tests/
  adapter-api/            # @haverstack/adapter-api
    src/
      index.ts            # APIAdapter (StackAdapter)
    tests/
```

---

## Spec

The design spec lives in [`docs/spec.md`](./docs/spec.md), which indexes focused sub-documents under [`docs/spec/`](./docs/spec). Together they cover the full data model, adapter contract, wire format, and open questions. If you're building an adapter or a server implementation, start there.

Shared, app-neutral record types (note, bookmark, task, contact) live in the [Schema Commons](./docs/commons/README.md) — start there if you want your app's data to interoperate with other Haverstack apps.

---

## Related

- [`haverstack/server`](https://github.com/haverstack/server) — reference server implementation

---

## License

[CC0 1.0 Universal](./LICENSE) — public domain. No rights reserved.
