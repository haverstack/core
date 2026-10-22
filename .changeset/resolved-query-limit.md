---
'@haverstack/core': minor
'@haverstack/adapter-api': minor
'@haverstack/adapter-local': patch
'@haverstack/adapter-conformance': patch
'@haverstack/conformance-fixtures': minor
'@haverstack/record-adapter-sqlite': patch
'@haverstack/record-adapter-do-sqlite': patch
---

`Stack.query()` and `ScopedStack.query()` resolve the default page size (50) before any adapter sees the query, as they do the sort direction. `queryRecords()` and `queryReadable()` take an `AdapterQuery`, exported from `@haverstack/core/adapter`: a `StackQuery` whose `limit` and sort `direction` are always present. No adapter carries a page size of its own, and `APIAdapter` always sends `limit`.
