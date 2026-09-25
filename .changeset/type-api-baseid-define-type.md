---
'@haverstack/core': minor
'@haverstack/commons': patch
---

`defineType()` takes a single object: `defineType({ id, name, schema, migratesFrom? })`, and `DefineTypeOptions` is that whole argument. A new `BaseId` alias names a type family; `StackType.baseId`, `RecordFilter.baseId`, `migrateAll(baseId)` and `grantType()`/`revokeType()`'s `typeOrBaseId: TypeId | BaseId` use it. `migrateAll()`'s parameter is renamed from `baseTypeId` to `baseId`.
