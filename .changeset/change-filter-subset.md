---
'@haverstack/core': minor
'@haverstack/adapter-api': minor
'@haverstack/conformance-fixtures': minor
---

`ChangeFilter` is a subset of `RecordFilter`, and every key means the same thing in both, so one filter drives `query()` and `subscribe()` alike. `typeId` is now an exact match; a subscriber that wants the whole type family passes `baseId`, which `GET /changes` carries as `?baseId=`. `createdBy` accepts lists and `principalId`, as on `RecordFilter` (`?createdByPrincipal=` on the wire). A `migrate` or `restore` that changes a record's type is delivered to subscribers of the type it left as well as the one it entered.
