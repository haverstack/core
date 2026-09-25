---
'@haverstack/core': minor
'@haverstack/conformance-fixtures': patch
---

Reshape the type-level grant methods to mirror the record-level `grantAccess(id, permission)`, and put their layer in their names:

- `Stack.grant(target, [{ typeId, actions }])` is `Stack.grantType(typeOrBaseId, { actions, grantee })`: subject first, grantee inside the element. It creates and returns one `_grant` record; the batch form is removed, so call it once per type. The element type is exported as `TypeGrant`.
- `Stack.revoke(target, [{ typeId, actions }])` is `Stack.revokeType(typeOrBaseId, { actions, grantee })`, returning the grants it withdrew.
- `Stack.listGrants()` is `Stack.listTypeGrants()`.
- All three return records typed with `content: GrantContent`.

`typeOrBaseId` accepts a bare baseId as well as a versioned TypeId. The record-level `grantAccess()`/`revokeAccess()` are unchanged.
