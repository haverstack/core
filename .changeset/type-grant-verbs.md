---
'@haverstack/core': minor
'@haverstack/conformance-fixtures': patch
---

Rename the type-level grant verbs so their layer is in the name: `Stack.grant()` → `Stack.grantType()`, `Stack.revoke()` → `Stack.revokeType()`, `Stack.listGrants()` → `Stack.listTypeGrants()`. The record-level `grantAccess()`/`revokeAccess()` are unchanged. The first parameter of `grantType()`/`revokeType()` is now `typeOrBaseId`, documenting that it accepts a bare baseId as well as a versioned TypeId.
