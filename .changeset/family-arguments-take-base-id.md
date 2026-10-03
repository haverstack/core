---
'@haverstack/core': minor
'@haverstack/conformance-fixtures': minor
---

An argument that means a whole type family takes a `BaseId` and refuses a versioned `TypeId` with a `StackValidationError` naming the family to pass instead. This covers `migrateAll()`, `grantType()`, `revokeType()` (whose `typeOrBaseId` is now `baseId`), and `RecordFilter.baseId` / `ChangeFilter.baseId`.

`GrantContent.typeId` is renamed `baseId`, and the `_grant@1` schema with it. Every `_grant` write now refuses a versioned or protected-system-type target, not only `grantType()`, and a stored grant whose `baseId` carries an `@version` suffix confers nothing. The `_grant@1` fixtures carry `baseId`, and two new fixtures pin the `POST /records` refusals.
