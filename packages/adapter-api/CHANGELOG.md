# @haverstack/adapter-api

## 0.12.1

### Patch Changes

- [#196](https://github.com/haverstack/core/pull/196) [`bc2224f`](https://github.com/haverstack/core/commit/bc2224f9dba882b3928d18a68d28d54fa966cb76) Thanks [@cuibonobo](https://github.com/cuibonobo)! - Harden query sorting and the change-feed client.
  - Validate `sort.direction` (and `sort.field`) at the invariant layer: the
    types promise `'asc' | 'desc'`, but a type is not a runtime guard, and a
    SQLite record adapter interpolates the direction straight into `ORDER BY`.
    An out-of-range value is now refused with `StackQueryError` instead of
    reaching SQL, closing a blind-injection sink reachable from any untrusted
    caller (a delegated app, or a server mapping `?direction=`). The SQL query
    builder re-checks defensively.
  - Change-feed SSE decoder: hold a trailing `\r` across chunk boundaries so a
    CRLF frame split between its CR and LF decodes as one frame, and cap an
    unterminated frame's buffer so a peer that never closes one cannot exhaust
    client memory.
  - Change-feed client: report an unparseable record frame through `onError`
    and keep reading instead of dropping the connection; refuse a resume cursor
    outside the seq charset locally; and stop reconnecting after a fatal auth or
    authorization failure rather than looping with backoff.

## 0.12.0

### Minor Changes

- [#193](https://github.com/haverstack/core/pull/193) [`d556069`](https://github.com/haverstack/core/commit/d5560696f3ec1d08e9d49f66b79cbf2f5036dfef) Thanks [@cuibonobo](https://github.com/cuibonobo)! - Relay changes that originate elsewhere. `Stack.subscribe()` now opens the adapter's feed alongside its own emitter, so a subscriber to a remote stack hears about writes made by anyone, and `onReset` — until now a documented option that could never fire — reaches the app when a gap opens that resumption could not close.

  `APIAdapter.subscribeChanges()` consumes `GET /changes` as SSE over `fetch`: refused locally when discovery advertises no feed, resolved once the server's `ready` frame makes subscribe-then-query gap-free, resumed with `Last-Event-ID`, reconnected with exponential backoff and full jitter, and re-authenticated through the existing single-flight 401 path.

  A relay is opened per subscription and carries that subscription's filter, because `entityId` and `parentId` are answerable only where the record is. A scoped view of a stack that relays refuses to subscribe with the new `StackRelayScopeError` rather than narrow a feed it cannot re-scope.

### Patch Changes

- Updated dependencies [[`d556069`](https://github.com/haverstack/core/commit/d5560696f3ec1d08e9d49f66b79cbf2f5036dfef)]:
  - @haverstack/wire-types@0.12.0
  - @haverstack/core@0.13.0

## 0.11.0

### Minor Changes

- Released for a breaking change in `@haverstack/wire-types`.

### Patch Changes

- Updated dependencies [[`ca0acdc`](https://github.com/haverstack/core/commit/ca0acdc78e6861fc371140b040898ce28279c435)]:
  - @haverstack/wire-types@0.11.0

## 0.10.0

### Minor Changes

- Released for a breaking change in `@haverstack/core`, `@haverstack/wire-types`.

### Patch Changes

- Updated dependencies [[`779ddd6`](https://github.com/haverstack/core/commit/779ddd6599c8b9049ca6fbf1516a4a54705e9609)]:
  - @haverstack/wire-types@0.10.0
  - @haverstack/core@0.12.0
