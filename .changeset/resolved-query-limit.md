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

Every `limit` — on `query()`, `getVersions()` and `getJournal()` — is a positive integer, and anything else is refused with `StackBadRequestError`. A journal `limit` of 0 is now refused.
