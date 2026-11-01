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
  ownerEntityId: async () => {
    const { did, privateKey } = await generateDidKeypair();
    await writeFile(keyPath, JSON.stringify(await exportDidPrivateKeyJwk(privateKey)));
    return did;
  },
});

// ownerProfile creates your own _entity profile record on first run —
// safe to keep passing on every open, it's a no-op once the record exists.
const stack = await Stack.open(adapter, { ownerProfile: { name: 'Jane Smith' } });

// Define a type. The handle carries the id, name and schema, and the compiler
// derives the content type from it — no separate interface to keep in step.
const Note = typeHandle({
  id: 'com.example.myapp/note@1',
  name: 'Note',
  schema: {
    text: { kind: 'text', required: true },
    title: { kind: 'string' },
  },
});
await stack.defineType(Note);

// Typed access to the Note family
const notes = stack.collection(Note);

// Create a record
const note = await notes.create({
  text: 'Hello, Haverstack!',
  title: 'My first note',
});

// Update its content (partial merge — only changed fields needed)
await notes.patchContent(note.id, { title: 'Updated title' });

// Read it back, typed: `content.text` is a string
const same = await notes.get(note.id);

// Tag it
await notes.editAssociations(note.id, [
  { op: 'add', association: { kind: 'tag', label: 'favourite' } },
]);

// Share it with everyone — each aspect of a record has its own verb
await notes.setAccess(note.id, [{ kind: 'anyone', label: 'read' }]);

// Query the family. stack.query() reads across every type you can see instead.
const { records: favourites } = await notes.query({
  filter: { tags: ['favourite'] },
  sort: { field: 'createdAt', direction: 'desc' },
});

// Tear down when done
await stack.close();
```

## Writing an app

An app has two layers, because the stack draws a line between them:

- **A data layer that takes a `StackClient`** — the record API `Stack` and `ScopedStack` both implement. The same code then runs embedded as the owner, or behind a server as a requester who reaches only what they were granted.
- **An install that the owner approves.** Defining types, `migrateAll()` and `grantType()` change the whole stack rather than one record, so they live on `Stack` alone and are absent from `StackClient`.

Migrations belong to neither. They are passed to `Stack.open()` on **every startup**, so the chain is complete before the first read.

```ts
import { Stack, map, migration, typeHandle } from '@haverstack/core';
import type { AppManifest, Collection, ContentOf, StackClient } from '@haverstack/core';

export const Shelf = typeHandle({
  id: 'com.example.reading/shelf@1',
  name: 'Shelf',
  schema: { name: { kind: 'string', required: true } },
});
const BookV1 = typeHandle({
  id: 'com.example.reading/book@1',
  name: 'Book',
  schema: {
    title: { kind: 'string', required: true },
    status: { kind: 'enum', values: ['reading', 'done'], required: true },
  },
});
export const Book = typeHandle({
  id: 'com.example.reading/book@2',
  name: 'Book',
  migratesFrom: BookV1,
  schema: {
    title: { kind: 'string', required: true },
    status: { kind: 'enum', values: ['reading', 'finished'], required: true },
    shelfId: { kind: 'record-ref' },
  },
});
export const Review = typeHandle({
  id: 'com.example.reading/review@1',
  name: 'Review',
  schema: {
    bookId: { kind: 'record-ref', required: true },
    rating: { kind: 'number', required: true },
    text: { kind: 'text' },
  },
});

export interface ShelfContent extends ContentOf<typeof Shelf.schema> {}
export interface BookContent extends ContentOf<typeof Book.schema> {}
export interface ReviewContent extends ContentOf<typeof Review.schema> {}

// Startup: pass to every Stack.open(). Each step is checked against both
// handles' schemas when migration() runs.
export const migrations = [migration(BookV1, Book, [map('status', { done: 'finished' })])];

// Data layer: one collection per type, and typed records from every verb.
export class Library {
  readonly shelves: Collection<ShelfContent>;
  readonly books: Collection<BookContent>;
  readonly reviews: Collection<ReviewContent>;

  constructor(client: StackClient) {
    this.shelves = client.collection(Shelf);
    this.books = client.collection(Book);
    this.reviews = client.collection(Review);
  }

  addBook(title: string, shelfId: string) {
    return this.books.create({ title, status: 'reading', shelfId });
  }

  finish(id: string) {
    return this.books.patchContent(id, { status: 'finished' });
  }

  review(bookId: string, rating: number, text?: string) {
    return this.reviews.create({ bookId, rating, ...(text && { text }) });
  }

  // Records at @1 come back migrated to @2. One written by a newer release
  // of the app can't be migrated down, so it is reported, not thrown.
  async onShelf(shelfId: string) {
    const page = await this.books.query({
      filter: { content: { shelfId } },
      sort: { contentField: 'title' },
    });
    if (page.misfits.length > 0) {
      console.warn(`${page.misfits.length} books need a newer version of this app`);
    }
    return page.records;
  }
}

// Install, when the owner runs the app. defineType() is a no-op for a
// schema already stored, so re-running after an upgrade is safe.
export async function install(stack: Stack) {
  for (const handle of [Shelf, BookV1, Book, Review]) await stack.defineType(handle);
  await stack.migrateAll(Book.baseId);
}

// Install, when the owner doesn't: the same handles, as a request.
export const manifest: AppManifest = {
  appId: 'com.example.reading',
  name: 'Reading',
  types: [Shelf, BookV1, Book, Review],
  requests: [Shelf, Book, Review].map((handle) => ({
    baseId: handle.baseId,
    actions: ['create', 'read-own', 'update-own', 'delete-own'],
  })),
};
```

**When the owner runs the app**, it opens with `Stack.open(adapter, { migrations })`, calls `install(stack)`, then `new Library(stack)`. A server hands each requester `new Library(stack.asActor(session))`.

**When the app runs elsewhere** — holding its own key and reaching the stack through `APIAdapter` — it can't define types, so it asks: `adapter.requestInstall(manifest)` resolves to `pending` until the owner approves. The owner reviews `stack.planInstall(manifest, { did })` and applies it with `stack.installApp(plan)`, which defines the types, registers the app's key and grants it the requests. The app still opens with its `migrations`, then builds `new Library(stack)` over its own connection. See [App installs](https://github.com/haverstack/core/blob/main/docs/spec/apps.md).

**Name content with an interface**, as above. `ContentOf` flattens its result, so a `type` alias shows the expanded object in editor hovers, while an interface keeps its name. typescript-eslint's recommended `no-empty-object-type` rule rejects an empty interface; its `allowInterfaces: 'with-single-extends'` option admits this one.

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

Types can evolve over time. A new version names the one it migrates from, and `migration()` builds the step between two handles from declared steps — `rename`, `map`, `add`, `drop` and `derive` — checked against both schemas when it runs. Pass every step to `Stack.open()`; the library composes adjacent steps into chains:

```ts
const NoteV2 = typeHandle({
  id: 'com.example.myapp/note@2',
  name: 'Note',
  migratesFrom: NoteV1,
  schema: { text: { kind: 'text', required: true }, title: { kind: 'string' } },
});

const stack = await Stack.open(adapter, {
  migrations: [migration(NoteV1, NoteV2, [add('title', '')])],
});
await stack.defineType(NoteV2);
```

Records stay at the version they were written at: `get()` and `query()` return them as stored, `presentAt: 'latest'` migrates them in memory for one read, and `stack.migrateAll()` commits a family to disk. Because the steps are declared rather than a function, a collection carries a content filter or sort across the versions they translate to — a filter on `title` reaches records still at `@1`. Pass migrations at every startup — see [Writing an app](#writing-an-app).

## License

[CC0 1.0 Universal](https://creativecommons.org/publicdomain/zero/1.0/) — public domain.

## Monorepo

Part of [haverstack/core](https://github.com/haverstack/core).
