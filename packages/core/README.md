# @haverstack/core

Core library for Haverstack — a portable personal data stack.

Apps write **Records** into a **Stack**, and the stack handles storage, querying, versioning, and associations, regardless of where data actually lives. Switch backends without changing your app.

> **Status:** Early development. APIs are unstable.

## Installation

```sh
npm install @haverstack/core
```

You'll also need a storage adapter:

- [`@haverstack/adapter-sqlite`](https://www.npmjs.com/package/@haverstack/adapter-sqlite) — local SQLite storage via sql.js

## Quick start

```ts
import { Stack } from '@haverstack/core';
import { SQLiteAdapter } from '@haverstack/adapter-sqlite';

// First run — initialize a new stack
const adapter = await SQLiteAdapter.initialize({
  path: './my-stack.db',
  entityId: 'my-entity-id',
  timezone: 'America/New_York',
});

// Subsequent runs — open the existing stack
// const adapter = await SQLiteAdapter.open({ path: './my-stack.db' });

const stack = await Stack.create(adapter);

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
await stack.flush();
await stack.close();
```

## Core concepts

### Records

The fundamental unit of data. Every record has:

- A **Crockford base-32 ID** — time-sortable, human-readable, URL-safe
- A **type** — defined by the app that created it
- **Content** — a JSON object validated against the type's schema
- Optional: `parentId`, `entityId`, `appId`, `permissions`, `associations`

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
{ kind: 'attachment',   label: 'avatar',   fileId: '...', mimeType: 'image/png' }
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
