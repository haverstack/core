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

| Wire type          | Domain type          | Serializer                |
| ------------------ | -------------------- | ------------------------- |
| `WireRecord`       | `StackRecord`        | `serializeRecord()`       |
| `WireType`         | `StackType`          | `serializeType()`         |
| `WireVersion`      | `RecordVersion`      | `serializeVersion()`      |
| `WireJournalEntry` | `RecordJournalEntry` | `serializeJournalEntry()` |
| `WireRecordChange` | `RecordChange`       | `serializeChange()`       |

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

## The rest of the contract

- **Errors** — `WireErrorCode`, `WIRE_ERROR_STATUS`, `serializeError()` and `deserializeError()` map the `StackError` taxonomy to and from a status and body; `errorForStatus()` recovers a class from a bodyless response. See [Wire format § Error responses](https://github.com/haverstack/core/blob/main/docs/spec/wire-format.md#error-responses).
- **Discovery** — `DiscoveryResponse`, `normalizeCapabilities()`, `WIRE_PROTOCOL_VERSION` and `isProtocolCompatible()`, so a client and a server read `GET /.well-known/stack` the same way.
- **Authentication** — the handshake's request/response types and its own error vocabulary (`WireAuthErrorCode`, `isRetryableAuthError()`).
- **Change feed** — frame names, `WireReadyFrame`/`WireResetFrame`, and `isValidCursor()`. See [Change feed](https://github.com/haverstack/core/blob/main/docs/spec/change-feed.md).

## License

[CC0 1.0 Universal](https://creativecommons.org/publicdomain/zero/1.0/) — public domain.

## Monorepo

Part of [haverstack/core](https://github.com/haverstack/core).
