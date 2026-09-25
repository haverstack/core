# @haverstack/adapter-conformance

A runnable conformance suite for `StackRecordAdapter` and `StackBlobAdapter` implementers.

`docs/spec/adapters.md` documents the adapter contract in prose. This package is the checked version: point it at your adapter and it runs the invariants — content-path filtering, `_config` protection, cursor stability, version snapshots, full-text search consistency, capability honesty — that every first-party adapter is held to.

> **Status:** Early development. APIs are unstable.

## Installation

```sh
npm install --save-dev @haverstack/adapter-conformance vitest
```

## Usage

```ts
import { runRecordAdapterConformance } from '@haverstack/adapter-conformance';
import { MyRecordAdapter, MY_RECORD_CAPABILITIES } from './my-adapter.js';

runRecordAdapterConformance({
  name: 'MyRecordAdapter',
  capabilities: MY_RECORD_CAPABILITIES,
  open: () => MyRecordAdapter.initialize({ path: tempDbPath() }),
  close: (adapter) => adapter.close?.(),
});
```

Call this at the top level of a `*.test.ts` file — it registers a normal `describe`/`it` tree via vitest, so it runs alongside your own tests. `open()` is called before every test and `close()` after, so give it a fresh, empty adapter instance each time.

`capabilities` is passed explicitly (the same object your adapter's own `capabilities` getter returns) rather than read off an opened instance, because vitest builds its test tree synchronously — before any `beforeEach` has run. Suites gated on a capability you don't declare (full-text search, content-field sort, path-reaching content filters) are skipped, never failed; every filtering test that does run includes a record that must **not** match, so declaring a capability you don't actually honor still fails loudly.

For blob adapters:

```ts
import { runBlobAdapterConformance } from '@haverstack/adapter-conformance';
import { MyBlobAdapter } from './my-blob-adapter.js';

runBlobAdapterConformance({
  name: 'MyBlobAdapter',
  listBlobs: true, // omit or set false if you don't implement the optional listBlobs()
  open: () => new MyBlobAdapter({ dir: tempDir() }),
});
```

Errors are asserted against `.code` (the `StackErrorCode` every `StackError` subclass carries) rather than `instanceof`, so the suite runs unmodified against an adapter reached through an RPC boundary — a Durable Object, a remote worker — where a thrown error's prototype chain doesn't survive the trip.

## What's covered

**Record adapters:** CRUD and not-found/conflict errors, the `_config` singleton's reserved-id exclusion from queries, associations (idempotent, never bump version), version snapshots and `restoreVersion` (content restored; containment and associations left where they stand), the change journal, `commitMigration`, cursor pagination (a cursor minted under one sort refused when replayed under another), content-path filtering (array spread, nested objects, `contentPresent`, null-matches-absent), sort by content field, and full-text search (including that a content patch is reflected — no stale matches under the old content).

**Blob adapters:** content-addressed `putBlob` (fileId is the SHA-256 hex of the bytes, identical bytes dedupe), byte-exact `getBlob`, the `not_found`/`bad_request` fileId error contract, `deleteBlob`, and the optional `listBlobs()`.

See `docs/spec/adapters.md` for the full prose contract this suite checks.

## License

[CC0 1.0 Universal](https://creativecommons.org/publicdomain/zero/1.0/) — public domain.

## Monorepo

Part of [haverstack/core](https://github.com/haverstack/core).
