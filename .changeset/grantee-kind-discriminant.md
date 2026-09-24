---
'@haverstack/core': minor
'@haverstack/conformance-fixtures': minor
'@haverstack/adapter-conformance': patch
'@haverstack/adapter-api': patch
'@haverstack/record-adapter-sqlite': patch
---

Record-level permission grantees now discriminate on `kind` instead of `scope`, matching type-level grant grantees: `{ kind: 'entity', entityId }` and `{ kind: 'group', groupId, role }`. The shared arms are exported as `Grantee`, with `GroupRole` naming `'member' | 'admin'`; `PermissionGrantee` is `Grantee` and `GrantGrantee` adds `{ kind: 'authenticated' }`. `GrantTarget` is removed — `grant()` and `revoke()` take a `GrantGrantee`. Relationship targets (`RelationshipTarget`, `RelationshipTargetPattern`) move to `kind` too — `{ kind: 'record' | 'entity' | 'external', … }` — so an entity target and an entity grantee are the same value.
