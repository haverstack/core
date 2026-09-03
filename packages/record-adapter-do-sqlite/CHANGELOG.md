# @haverstack/record-adapter-do-sqlite

## 0.3.0

### Minor Changes

- [#220](https://github.com/haverstack/core/pull/220) [`f568011`](https://github.com/haverstack/core/commit/f568011af1f3ba41ea4671cd879b845285574eba) Thanks [@cuibonobo](https://github.com/cuibonobo)! - Match a `content` filter key as a literal top-level field name. The key is quoted and escaped into the JSON path rather than interpolated, so `{ 'a.b': 1 }` now selects the field called `a.b` instead of `b` nested inside `a`, a key like `arr[0]` selects that field instead of an array element, and a key that is not path-shaped (`$.`, a stray bracket) is an ordinary zero-match filter instead of a raw SQLite "bad JSON path" error. Brings both SQLite adapters in line with the literal lookup every other adapter performs.

### Patch Changes

- Updated dependencies [[`5324f8e`](https://github.com/haverstack/core/commit/5324f8ec4ef6ef2225f3c05661e3d3d1d860512b), [`d0c0bb2`](https://github.com/haverstack/core/commit/d0c0bb25bae95f1285e2b2a0db980d0c4d215ac2), [`5324f8e`](https://github.com/haverstack/core/commit/5324f8ec4ef6ef2225f3c05661e3d3d1d860512b)]:
  - @haverstack/core@0.18.0

## 0.2.0

### Minor Changes

- Released for a breaking change in `@haverstack/core`.

### Patch Changes

- Updated dependencies [[`d27cfe4`](https://github.com/haverstack/core/commit/d27cfe4fc09406abda36c1c93f071446e13ef7b8)]:
  - @haverstack/core@0.17.0

## 0.1.1

### Patch Changes

- [#215](https://github.com/haverstack/core/pull/215) [`c01f8de`](https://github.com/haverstack/core/commit/c01f8de8c3ddaa931e7de8b428d18fbe1eb4f38c) Thanks [@cuibonobo](https://github.com/cuibonobo)! - Add `@haverstack/record-adapter-do-sqlite` — a `StackRecordAdapter` over Cloudflare
  Durable Objects' SQLite storage, for Workers deployments with no Node runtime
  available. Reuses `SharedSqlRecordLogic`, the FTS5 schema and strategy, the query
  builder, cursor codec, and row mappers from `@haverstack/sqlite-shared` — the same
  shared layer `record-adapter-sqlite` is built on, now via its `./record` subpath
  (the token-store and file-lock pieces stay Node-only and unreachable from this
  adapter's bundle). No lock file: a Durable Object id maps to exactly one running
  instance, so the platform itself is the single-writer guarantee. No persist/flush
  step: every write through `ctx.storage.sql` is durable by the time the call returns.

  `@haverstack/sqlite-shared`'s `SqlExecutor` gained a `transaction<T>(fn: () => T): T`
  primitive, replacing the raw `BEGIN`/`COMMIT`/`ROLLBACK` statements `record-logic.ts`
  used to issue directly. Durable Object SQLite storage rejects those statements
  outright and does not roll back a write on a later exception the way an open SQL
  transaction would (verified against the real Workers runtime) — its real primitive
  is `ctx.storage.transactionSync(fn)`, a callback boundary that three independent
  string-based `exec()` calls can't reach. `record-adapter-sqlite`'s executor
  implements `transaction()` as literal `BEGIN`/`COMMIT`/`ROLLBACK` around `fn()`,
  behavior-identical to what the inline code did before — its full test suite passes
  unchanged.
