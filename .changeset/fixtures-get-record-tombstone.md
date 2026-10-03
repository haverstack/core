---
'@haverstack/conformance-fixtures': minor
---

Adds `getRecordSequenceFixtures`: `GET /records/:id` answers `404` for a soft-deleted record unless `?includeDeleted=true`.
