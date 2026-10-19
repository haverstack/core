---
'@haverstack/core': minor
'@haverstack/record-adapter-sqlite': minor
'@haverstack/record-adapter-do-sqlite': minor
'@haverstack/adapter-local': minor
'@haverstack/adapter-conformance': minor
'@haverstack/conformance-fixtures': patch
---

Scope a `ScopedStack.query()` inside the adapter rather than after it. `ScopedStack` describes what the requester may read as a `ReadReach` — a type fence for a delegated principal, the types read whole, the types read where the subject authored, and the permission elements that convey read — and an adapter implementing the new optional `queryReadable(query, reach)` matches it as one more condition of the query. Pages, cursors and whether a cursor comes back are then decided among readable records alone, so a cursor never names a record the requester cannot read, and a page is full whenever readable records remain. `MemoryAdapter`, the SQLite adapters and `LocalAdapter` implement it; `inReach()` in `@haverstack/core/adapter` is the reference predicate, and the conformance suite holds adapters to it. An adapter without the method keeps the bounded scan.
