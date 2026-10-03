---
'@haverstack/core': minor
'@haverstack/conformance-fixtures': minor
'@haverstack/adapter-conformance': patch
'@haverstack/record-adapter-sqlite': patch
---

A sort that names a field now defaults to ascending, native or content field alike, as `ORDER BY` does; a query with no sort still returns `createdAt`, newest first. `Stack.query()` resolves both defaults before an adapter sees the query, so `queryRecords()` always receives an explicit `direction`. `listTypeGrants()` states its newest-first order rather than inheriting it.
