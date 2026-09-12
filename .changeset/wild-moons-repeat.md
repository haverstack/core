---
'@haverstack/core': minor
'@haverstack/adapter-api': minor
---

Name the missing capability on the refusal itself, and remove the copy of the rule that re-derived it.

`StackQueryError` now carries a `capability` field — the path into adapter capabilities the query needed (`'filter.content'`, `'filter.contentPresent'`, `'filter.search'`, `'sort.fields'`, `'sort.contentField'`), or undefined when the query's own shape was what was wrong. `assertQueryCapabilities()` and `assertSortCapability()` set it at each refusal. `APIAdapter.queryRecords()` reads it instead of re-deriving the answer from the query, which it could disagree with: a query that both sorted by an undeclared field and used an undeclared `filter.search` reported the sort as the missing capability while the message named the search.

`filtersContent()` and the `MissingCapability` type are now exported from `@haverstack/core/adapter`; `adapter-api` re-exports `MissingCapability` under its existing name. `MissingCapability` is also exported from `@haverstack/core`'s main entry, where `StackQueryError` itself ships — app code catching a refusal from `Stack.query()` needs the type to name the field it just read.

`@haverstack/core/wire` now exports `assertQueryTravels()`, the build-side half of the refusal `parseQueryParams()`/`parseQueryBody()` already apply to the two `Query` fields with no wire encoding. `APIAdapter.queryRecords()` calls it before choosing an encoding, so a direct adapter call carrying `filter.baseId` or `presentAt` is refused the same way at every content reach. Previously only the `POST /records/query` body carried them as far as the server's `400`: the `GET /records` params have nowhere to put them, so the same query came back as an unfiltered result set. (`Stack.query()` resolves `baseId` and applies `presentAt` itself, so queries made through it were never affected.)

`APIAdapter.createRecord()`, `commitMigration()`, `undeleteRecord()` and `restoreVersion()` now report a server that answers a version-bumping mutation with no Record body, as the other mutations already did, instead of raising a `TypeError` from reading the body that never arrived.
