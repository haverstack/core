---
'@haverstack/core': minor
'@haverstack/wire-types': minor
'@haverstack/conformance-fixtures': minor
'@haverstack/adapter-api': minor
'@haverstack/record-adapter-sqlite': minor
'@haverstack/record-adapter-do-sqlite': minor
---

Remove `total` from `QueryResult`. A query answers with `records` and
`cursor`.

The count was only ever a number on one of the three paths a query can
take. A permission-scoped query could not report one — the count of
matching Records reveals the cardinality the permission check just hid —
and neither could any response on the wire, for the same reason. That left
it populated on a direct unscoped `Stack.query()` in process and `null`
everywhere else, so an app reading it saw a number locally and `null` the
moment the same code ran scoped or against a server.

Meanwhile every path paid for it. `ScopedStack.query()` filters and refills
by calling the adapter per page, so one scoped query at `limit: 50` ran
eleven `COUNT(*)`s and discarded all eleven. Measured over 20k records, the
count was 74% of a scoped query and 77% of an `asEntity(null)` one.

A caller that needs a count follows `cursor` to exhaustion and counts what
arrives — the only number that was ever true for that requester.

`MemoryAdapter` and the SQL adapters had also disagreed about what the
field meant: the documented "ignoring pagination" (which `MemoryAdapter`
implemented) against the count of what remained after the cursor (which the
SQL adapters returned). Removing the field settles it.
