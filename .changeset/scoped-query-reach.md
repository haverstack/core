---
'@haverstack/core': minor
'@haverstack/record-adapter-sqlite': minor
'@haverstack/record-adapter-do-sqlite': minor
'@haverstack/adapter-local': minor
'@haverstack/adapter-conformance': minor
'@haverstack/conformance-fixtures': patch
---

State what a scoped requester may read once, as a `ReadReach` — a type fence for a delegated principal, and within it the types read whole, the types read where the subject authored, and the permission elements that convey read — and answer every read from it: `get()` and the change feed ask it of one record, and `query()` hands it to the adapter's new `queryReadable(query, reach)`, which matches it as one more condition. Pages, cursors and whether a cursor comes back are decided among readable records alone, so a cursor never names a record the requester cannot read. A scoped `query()` over an adapter without `queryReadable()` is refused with `ScopeUnavailableError`, which replaces `RelayScopeError` for the matching `subscribe()` refusal. `MemoryAdapter`, the SQLite adapters and `LocalAdapter` implement it; `inReach()` in `@haverstack/core/adapter` is the reference predicate, and the conformance suite holds adapters to it. A requester's grants and rosters are each read at most once per operation, with rosters read by one query rather than one fetch per group.
