# @haverstack/wire-types

HTTP wire types and serialization utilities for the Haverstack API.

This package defines the JSON-safe representations of Haverstack's core domain types — `Date` fields become ISO strings — and provides functions to serialize domain objects into that format and parse dates back out. It is the shared contract between `haverstack/server` (which serializes responses) and `@haverstack/adapter-api` (which parses them).

> **Status:** Early development. APIs are unstable.

## Installation

```sh
npm install @haverstack/wire-types
```

## Wire types

Each wire type mirrors a domain type from `@haverstack/core` with `Date` fields replaced by ISO 8601 strings.

| Wire type | Domain type |
|-----------|-------------|
| `WireRecord` | `StackRecord` |
| `WireType` | `StackType` |
| `WireVersion` | `RecordVersion` |

## Serialization

```ts
import {
  serializeRecord,
  serializeType,
  serializeVersion,
  parseDate,
} from '@haverstack/wire-types';

// Server side — convert domain objects before sending as JSON
const body = JSON.stringify(serializeRecord(record));

// Client side — convert ISO strings back to Dates after parsing JSON
const createdAt = parseDate(raw.createdAt); // Date | undefined
```

`parseDate` accepts `unknown` and returns `undefined` for missing or unparseable values, making it safe to use directly on unvalidated response fields.

## License

[CC0 1.0 Universal](https://creativecommons.org/publicdomain/zero/1.0/) — public domain.

## Monorepo

Part of [haverstack/core](https://github.com/haverstack/core).
