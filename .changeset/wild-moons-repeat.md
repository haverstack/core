---
'@haverstack/core': minor
'@haverstack/adapter-api': minor
---

Name the missing capability on the refusal itself, and remove the copy of the rule that re-derived it.

`StackQueryError` now carries a `capability` field — the path into adapter capabilities the query needed (`'filter.content'`, `'filter.contentPresent'`, `'filter.search'`, `'sort.fields'`, `'sort.contentField'`), or undefined when the query's own shape was what was wrong. `assertQueryCapabilities()` and `assertSortCapability()` set it at each refusal. `APIAdapter.queryRecords()` reads it instead of re-deriving the answer from the query, which it could disagree with: a query that both sorted by an undeclared field and used an undeclared `filter.search` reported the sort as the missing capability while the message named the search.

`filtersContent()` and the `MissingCapability` type are now exported from `@haverstack/core/adapter`; `adapter-api` re-exports `MissingCapability` under its existing name.

`APIAdapter.createRecord()`, `commitMigration()`, `undeleteRecord()` and `restoreVersion()` now report a server that answers a version-bumping mutation with no Record body, as the other mutations already did, instead of raising a `TypeError` from reading the body that never arrived.
