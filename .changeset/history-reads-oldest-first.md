---
'@haverstack/core': minor
'@haverstack/wire-types': minor
'@haverstack/adapter-api': minor
'@haverstack/adapter-conformance': minor
'@haverstack/conformance-fixtures': minor
'@haverstack/record-adapter-sqlite': minor
'@haverstack/record-adapter-do-sqlite': minor
---

`getVersions()` reads oldest first and pages forward with `afterVersion`, the order and cursor `getJournal()` already uses. `VersionsQuery.beforeVersion` and `GET /records/:id/versions?beforeVersion=` are replaced by `afterVersion`. See docs/spec/versioning.md § History reads share one order.
