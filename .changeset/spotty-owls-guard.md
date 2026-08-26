---
'@haverstack/core': patch
'@haverstack/record-adapter-sqlite': patch
'@haverstack/adapter-api': patch
---

Harden query sorting and the change-feed client.

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
