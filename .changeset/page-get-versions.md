---
'@haverstack/core': minor
'@haverstack/adapter-api': minor
'@haverstack/adapter-conformance': minor
'@haverstack/conformance-fixtures': minor
'@haverstack/record-adapter-sqlite': minor
'@haverstack/wire-types': minor
---

`getVersions()` takes an optional `VersionsQuery` (`beforeVersion`, `limit`) and pages newest first, in the shape of `getJournal()`'s `JournalQuery`; omitting both reads every version. `GET /records/:id/versions` takes `?limit=` and `?beforeVersion=` and answers `{ versions, cursor }`, with `parseVersionsParams()` in `@haverstack/core/wire` to decode them. `APIAdapter` follows `cursor` to the end when no `limit` is given.
