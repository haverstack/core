# @haverstack/core

Core library for Haverstack — a portable personal data stack.

Apps write **Records** into a **Stack**, and the stack handles storage, querying, versioning, and associations, regardless of where data actually lives. Switch backends without changing your app.

> **Status:** Early development. APIs are unstable.

## Installation

```sh
npm install @haverstack/core
```

You'll also need a storage adapter:

- [`@haverstack/adapter-local`](https://www.npmjs.com/package/@haverstack/adapter-local) — local storage (native SQLite + disk), single-app/embedded or server use

## Quick start

```ts
import { Stack } from '@haverstack/core';
import { generateDidKeypair, exportDidPrivateKeyJwk } from '@haverstack/core/did';
import { LocalAdapter } from '@haverstack/adapter-local';
import { writeFile } from 'node:fs/promises';

const dbPath = './my-stack.db';
const keyPath = './my-stack.key.json'; // see "Key custody" below for where this really belongs

// First run: neither file exists yet, so this generates an identity
// keypair and persists the private key before initializing. Every run
// after that: the db exists, so this just opens it — the entityId
// function below is never called, so no throwaway keypair is minted.
const adapter = await LocalAdapter.openOrInitialize({
  path: dbPath,
  timezone: 'America/New_York',
  entityId: async () => {
    const { did, privateKey } = await generateDidKeypair();
    await writeFile(keyPath, JSON.stringify(await exportDidPrivateKeyJwk(privateKey)));
    return did;
  },
});

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

// Tear down when done
await stack.close();
```

## Core concepts

### Records

The fundamental unit of data. Every record has:

- A **Crockford base-32 ID** — time-sortable, human-readable, URL-safe
- A **type** — defined by the app that created it
- **Content** — a JSON object validated against the type's schema
- Optional: `parentId`, `entityId`, `appId`, `principalId`, `permissions`, `associations`

### Identity

`entityId` is a DID string (e.g. `did:key:z6Mk...`) — a keypair, not a name issued by any provider. `generateDidKeypair()` mints the mandatory floor method, `did:key`. `_entity` records are local profile cards _about_ a DID (`{ did, name, handle? }`), not the identity itself — the petname pattern. See [Identity](https://github.com/haverstack/core/blob/main/docs/spec/identity.md) in the spec.

**Key custody.** Nothing in `@haverstack/core` or any adapter stores the `privateKey` — only the public `did` travels with stack data. Persisting it (JWK via `exportDidPrivateKeyJwk()`/`importDidPrivateKeyJwk()`, or the `CryptoKey` itself in a browser's IndexedDB) is on you. Losing it doesn't break anything local — but you can never again authenticate as that identity to a server, since `did:key` identity _is_ the key. See [Key custody](https://github.com/haverstack/core#key-custody) in the main README for per-platform recipes.

### Types

Types define the schema for a record's content. They are identified by a namespaced, versioned string:

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

Types can evolve over time. Register migration functions between adjacent versions and the library composes them into chains automatically:

```ts
await stack.defineType(
  'com.example.myapp/note@2',
  'Note',
  { text: { kind: 'text', required: true }, title: { kind: 'string' } },
  { migratesFrom: 'com.example.myapp/note@1' },
);

stack.registerMigration({
  from: 'com.example.myapp/note@1',
  to: 'com.example.myapp/note@2',
  migrate: (content) => ({ ...content, title: '' }),
});
```

Migration is **lazy** — records are migrated in memory on read and committed to disk on the next update. Use `stack.migrateAll()` to commit eagerly.

## License

[CC0 1.0 Universal](https://creativecommons.org/publicdomain/zero/1.0/) — public domain.

## Monorepo

Part of [haverstack/core](https://github.com/haverstack/core).
