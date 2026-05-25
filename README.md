# Haverstack

A portable personal data stack. Take your data with you.

Haverstack is a structured data store for individuals and small organizations. Apps write **Records** into your **stack** — and the stack handles storage, querying, versioning, and permissions, regardless of where data actually lives.

> **Status:** Early development. APIs are unstable.

---

## What is a stack?

A stack is a personal or organizational data store. It belongs to one **Entity** (a person or org) and holds **Records** — structured data objects that apps create and read.

The key idea: apps only talk to the Haverstack library. They don't know or care whether the underlying storage is a local SQLite database, a folder of JSON files, or a remote server. Switch backends without changing your app.

---

## Packages

This is a monorepo. Packages are published to npm under the `@haverstack` scope.

| Package                                                   | Description                                           |
| --------------------------------------------------------- | ----------------------------------------------------- |
| [`@haverstack/core`](./packages/core)                     | Stack class, types, schema, validation, ID generation |
| [`@haverstack/adapter-sqlite`](./packages/adapter-sqlite) | SQLite storage adapter                                |

Planned:

| Package                    | Description               |
| -------------------------- | ------------------------- |
| `@haverstack/adapter-json` | JSON file storage adapter |
| `@haverstack/adapter-api`  | Remote server adapter     |

---

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

// Tear down when done (flushes pending writes and releases resources)
await stack.flush();
await stack.close();
```

---

## Core concepts

### Records

The fundamental unit of data. Every record has:

- A **Crockford base-32 ID** — time-sortable, human-readable, URL-safe
- A **type** — defined by the app that created it
- **Content** — a JSON object validated against the type's schema
- Optional: `parentId`, `entityId`, `appId`, `permissions`, `associations`

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
{ kind: 'attachment',   label: 'avatar',   fileId: '...', mimeType: 'image/png' }
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

| Adapter    | Use case                                                  |
| ---------- | --------------------------------------------------------- |
| SQLite     | Local app storage, full query support, FTS                |
| JSON files | Portable, human-readable, backup/export _(planned)_       |
| Server API | Hosted/shared stacks, permissions enforcement _(planned)_ |

---

## Development

This repo uses [pnpm workspaces](https://pnpm.io/workspaces).

```sh
# Install dependencies
pnpm install

# Run all tests
pnpm test

# Typecheck all packages
pnpm typecheck

# Build all packages
pnpm build
```

### Project structure

```
docs/
  spec.md                 # Design spec — data model, wire format, adapter contract
packages/
  core/                   # @haverstack/core
    src/
      index.ts            # Public exports
      types.ts            # All type definitions
      stack.ts            # Stack class
      id.ts               # Crockford base-32 ID generation
      schema.ts           # Schema hashing and type compatibility
      validate.ts         # Content validation
    tests/
  adapter-sqlite/         # @haverstack/adapter-sqlite
    src/
      index.ts            # SQLiteAdapter
    tests/
```

---

## Spec

The design spec lives in [`docs/spec.md`](./docs/spec.md). It covers the full data model, adapter contract, wire format, and open questions. If you're building an adapter or a server implementation, start there.

---

## Related

- [`haverstack/server`](https://github.com/haverstack/server) — reference server implementation _(coming soon)_

---

## License

[CC0 1.0 Universal](./LICENSE) — public domain. No rights reserved.
