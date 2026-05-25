# @haverstack/adapter-sqlite

SQLite storage adapter for [Haverstack](https://www.npmjs.com/package/@haverstack/core).

Implements the `StackAdapter` interface using [sql.js](https://github.com/sql-js/sql.js). Runs in Node.js without native compilation. The database is held in memory and flushed to disk after every write.

> **Status:** Early development. APIs are unstable.

## Installation

```sh
npm install @haverstack/adapter-sqlite @haverstack/core
```

## Usage

```ts
import { Stack } from '@haverstack/core';
import { SQLiteAdapter } from '@haverstack/adapter-sqlite';

// First run — create a new database
const adapter = await SQLiteAdapter.initialize({
  path: './my-stack.db',
  entityId: 'my-entity-id',
  timezone: 'America/New_York',
});

// Subsequent runs — open the existing database
// const adapter = await SQLiteAdapter.open({ path: './my-stack.db' });

const stack = await Stack.create(adapter);

// ... use the stack (see @haverstack/core for the full API)

await stack.flush();
await stack.close();
```

## API

### `SQLiteAdapter.initialize(opts)`

Creates a new database at `opts.path`. Throws if the file already exists.

| Option     | Type     | Description                            |
| ---------- | -------- | -------------------------------------- |
| `path`     | `string` | Absolute path to the `.db` file        |
| `entityId` | `string` | Entity ID of the stack owner           |
| `timezone` | `string` | IANA timezone string (e.g. `America/New_York`) |

### `SQLiteAdapter.open(opts)`

Opens an existing database at `opts.path`. Throws if the file does not exist.

| Option | Type     | Description                             |
| ------ | -------- | --------------------------------------- |
| `path` | `string` | Absolute path to an existing `.db` file |

## Storage layout

Given a database at `./my-stack.db`, attachments are stored in `./attachments/`.

## Capabilities

| Feature            | Supported |
| ------------------ | --------- |
| Full-text search   | Yes (FTS4) |
| Content field query | Yes       |
| Sortable fields    | `createdAt`, `updatedAt`, `version` |

## License

[CC0 1.0 Universal](https://creativecommons.org/publicdomain/zero/1.0/) — public domain.

## Monorepo

Part of [haverstack/core](https://github.com/haverstack/core).
