---
'@haverstack/adapter-api': minor
---

`APIAdapter.getRecord()` sends `?includeDeleted=true`, since `GET /records/:id` answers `404` for a tombstone without it and `Stack` decides whether to hide one.
