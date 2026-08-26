# @haverstack/record-adapter-sqlite

## 0.5.1

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

## 0.5.0

### Minor Changes

- Released for a breaking change in `@haverstack/core`.

### Patch Changes

- Updated dependencies [[`d556069`](https://github.com/haverstack/core/commit/d5560696f3ec1d08e9d49f66b79cbf2f5036dfef)]:
  - @haverstack/core@0.13.0

## 0.4.0

### Minor Changes

- Released for a breaking change in `@haverstack/core`.

### Patch Changes

- Updated dependencies [[`779ddd6`](https://github.com/haverstack/core/commit/779ddd6599c8b9049ca6fbf1516a4a54705e9609)]:
  - @haverstack/core@0.12.0
