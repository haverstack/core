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
import { Stack, typeHandle } from '@haverstack/core';
import { generateDidKeypair, exportDidPrivateKeyJwk } from '@haverstack/core/did';
import { LocalAdapter } from '@haverstack/adapter-local';
import { writeFile } from 'node:fs/promises';

const dbPath = './my-stack.db';
const keyPath = './my-stack.key.json'; // see "Key custody" under Identity for where this really belongs

// First run: neither file exists yet, so this generates an identity
// keypair and persists the private key before creating the store. Every run
// after that: the db exists, so this just opens it — the ownerEntityId
// function below is never called, so no throwaway keypair is minted.
const adapter = await LocalAdapter.open({
  path: dbPath,
  create: 'ifMissing',
  timezone: 'America/New_York',
  ownerEntityId: async () => {
    const { did, privateKey } = await generateDidKeypair();
    await writeFile(keyPath, JSON.stringify(await exportDidPrivateKeyJwk(privateKey)));
    return did;
  },
});

// ownerProfile creates your own _entity profile record on first run —
// safe to keep passing on every open, it's a no-op once the record exists.
const stack = await Stack.open(adapter, { ownerProfile: { name: 'Jane Smith' } });

// Define a type. The handle carries the id and schema, and the compiler
// derives the content type from it — no separate interface to keep in step.
const Note = typeHandle('com.example.myapp/note@1', {
  text: { kind: 'text', required: true },
  title: { kind: 'string' },
});
await stack.defineType({ ...Note, name: 'Note' });

// Create a record
const note = await stack.create(Note, {
  text: 'Hello, Haverstack!',
  title: 'My first note',
});

// Update its content (partial merge — only changed fields needed)
await stack.patchContent(Note, note.id, { title: 'Updated title' });

// Read it back, typed: `content.text` is a string
const same = await stack.get(Note, note.id);

// Tag it
await stack.associate(note.id, [{ kind: 'tag', label: 'favourite' }]);

// Or change several things at once — one version, one atomic write
await stack.mutate(note.id, {
  contentPatch: { title: 'Final title' },
  permissions: [{ kind: 'anyone', label: 'read' }],
  unlisted: false,
});

// Query
const notes = await stack.query({
  filter: { typeId: 'com.example.myapp/note@1', tags: ['favourite'] },
  sort: { field: 'createdAt', direction: 'desc' },
});

// Tear down when done
await stack.close();
```

## Writing an app

An app has two layers, because the stack draws a line between them:

- **A data layer that takes a `StackClient`** — the record API `Stack` and `ScopedStack` both implement. The same code then runs embedded as the owner, or behind a server as a requester who reaches only what they were granted.
- **An install function that takes a `Stack`**, run by the owner. Defining types, `migrateAll()` and `grantType()` change the whole stack rather than one record, so they live on `Stack` alone and are absent from `StackClient`. Over the wire, `POST /types` and `POST /records/:id/migrate` are served to the owner acting alone.

`registerMigration()` belongs to neither. Its registry lives in memory on each `Stack` instance, so it runs at **every startup**, right after `Stack.open()` — an install function that registers migrations and runs once leaves every later start without them.

```ts
import { Stack, typeHandle, type StackClient } from '@haverstack/core';

const NoteV1 = typeHandle('com.example.myapp/note@1', {
  text: { kind: 'text', required: true },
});
export const Note = typeHandle('com.example.myapp/note@2', {
  text: { kind: 'text', required: true },
  pinned: { kind: 'boolean', required: true },
});

// Data layer: whoever the stack lets in.
export class Notes {
  constructor(private readonly client: StackClient) {}
  add(text: string) {
    return this.client.create(Note, { text, pinned: false });
  }
  pin(id: string) {
    return this.client.patchContent(Note, id, { pinned: true });
  }
  list() {
    return this.client.query(Note);
  }
}

// Startup: every open, every Stack instance.
export function registerNoteMigrations(stack: Stack) {
  stack.registerMigration({
    from: NoteV1.id,
    to: Note.id,
    migrate: (content) => ({ ...content, pinned: false }),
  });
}

// Install: the owner, once per stack and again after a schema change.
// defineType() is a no-op for a schema already stored, so re-running is safe.
export async function installNotes(stack: Stack, appDid?: string) {
  await stack.defineType({ ...NoteV1, name: 'Note' });
  await stack.defineType({ ...Note, name: 'Note', migratesFrom: NoteV1.id });
  await stack.migrateAll(Note.baseId);
  if (appDid) {
    await stack.grantType(Note.baseId, {
      actions: ['create', 'read-own', 'update-own', 'delete-own'],
      grantee: { kind: 'entity', entityId: appDid },
    });
  }
}
```

The owner's own app calls `registerNoteMigrations(stack)` and `installNotes(stack)`, then `new Notes(stack)`. A server hands each requester `new Notes(stack.asActor(session))`. An app that isn't the owner has no way to install its own types yet; the owner runs its install function for it.

## Core concepts

### Records

The fundamental unit of data. Every record has:

- A **Crockford base-32 ID** — time-sortable, human-readable, URL-safe
- A **type** — defined by the app that created it
- **Content** — a JSON object validated against the type's schema
- Optional: `parentId`, `createdBy`, `appId`, `permissions`, `associations`

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
{ kind: 'relationship', label: 'reply-to', target: { kind: 'record', recordId: '...' } }
```

### Migrations

Types can evolve over time. Register migration functions between adjacent versions and the library composes them into chains automatically:

```ts
await stack.defineType({
  id: 'com.example.myapp/note@2',
  name: 'Note',
  schema: { text: { kind: 'text', required: true }, title: { kind: 'string' } },
  migratesFrom: 'com.example.myapp/note@1',
});

stack.registerMigration({
  from: 'com.example.myapp/note@1',
  to: 'com.example.myapp/note@2',
  migrate: (content) => ({ ...content, title: '' }),
});
```

Records stay at the version they were written at: `get()` and `query()` return them as stored, `presentAt: 'latest'` migrates them in memory for one read, and `stack.migrateAll()` commits a family to disk. Register migrations at every startup — see [Writing an app](#writing-an-app).

## License

[CC0 1.0 Universal](https://creativecommons.org/publicdomain/zero/1.0/) — public domain.

## Monorepo

Part of [haverstack/core](https://github.com/haverstack/core).
