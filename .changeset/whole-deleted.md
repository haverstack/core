---
'@haverstack/core': minor
'@haverstack/conformance-fixtures': minor
'@haverstack/adapter-api': minor
---

A query can read soft-deleted Records whole: `filter.wholeDeleted`, beside `includeDeleted`, answers each one as stored, `deletedAt` still set, rather than as its tombstone.

- Owner-only under `ScopedStack`, refused with `StackPermissionError` (`403 permission`) otherwise, as `includeUnlisted` is. Without `includeDeleted` it is `StackBadRequestError` (`400`). A query that does not ask still gets the tombstone, so an ordinary read always shows a deleted Record as deleted.
- `GET /records` takes `?wholeDeleted=` and `POST /records/query` a `filter.wholeDeleted` key; `parseQueryParams()` and `parseQueryBody()` read both, and `APIAdapter` sends it.
- `copyStack()` and every read `Stack` makes past deletion on the owner's standing (attachment collection and reference checks, binding uniqueness, install and `_app` lookups, `migrateAll()`, `getAttachmentRecords()`, the owner's `getEntityByDid()`) ask for it. A copy out of a hosted stack now carries soft-deleted Records whole, and `Stack` over `APIAdapter` reads them as it does over a local adapter, so collection there no longer misses what a soft-deleted Record references.
- Fixtures: `queryWholeDeletedFixtures` (a whole read, a non-owner and a delegated refusal) and `error-bad-request-whole-deleted-without-include-deleted`.
