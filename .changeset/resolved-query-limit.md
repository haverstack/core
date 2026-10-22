---
'@haverstack/core': minor
'@haverstack/wire-types': minor
'@haverstack/adapter-api': minor
'@haverstack/adapter-conformance': minor
'@haverstack/adapter-local': patch
'@haverstack/record-adapter-sqlite': patch
'@haverstack/record-adapter-do-sqlite': patch
---

`Stack` resolves every query default before an adapter sees the query: the sort (`createdAt`, newest first, when none is named), its direction, and the page size (50, capped at 1000). `queryRecords()` and `queryReadable()` take an `AdapterQuery` whose `sort` and `limit` are always present, built by `resolveQuery()`, which `@haverstack/core/adapter` exports beside `AdapterQuery` and `AdapterSort`. No adapter carries a default of its own, and `APIAdapter` always sends the sort, direction and limit.

`createdAt` is the floor of `sort.fields`: every adapter orders by it, and `normalizeCapabilities()` reads it into any list a server declares. The conformance suite checks that an adapter declares it.

Every query entry point runs two checks, both exported from `@haverstack/core/adapter`: `resolveQuery()` for the query's shape, and `assertQueryCapabilities(query, capabilities)` for its filter and sort together. `assertSortCapability` is no longer exported. A sort must name exactly one of `field`, `contentField` or `contentFieldByType`, so a `direction` alone, in process or as `?direction=` on the wire, is refused.

Every `limit` — on `query()`, `getVersions()` and `getJournal()` — is a positive integer, and anything else is refused with `StackBadRequestError` by `Stack`. A journal `limit` of 0 is now refused. The wire parsers decode shape only and leave the range to `Stack`: `parseQueryBody()` decodes a numeric `limit` as given, and `parsePositiveInt` is renamed `parseUnsignedInt`, since it always accepted 0.

`APIAdapter.queryRecords()` trusts the query it is given. `Stack` has already checked it against `APIAdapter`'s capabilities, so a query the server cannot answer is refused with the same `StackBadRequestError`, naming the capability, that any adapter's would get, and still before a request is sent. `APIAdapterCapabilityError` now covers only the endpoints discovery advertises beside `capabilities` (`'changes'` and `'installs'`), and `@haverstack/adapter-api` no longer re-exports `MissingCapability`. `AdapterQuery` no longer carries `presentAt`, which `Stack` applies itself.
