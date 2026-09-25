---
'@haverstack/core': minor
'@haverstack/conformance-fixtures': minor
'@haverstack/adapter-conformance': patch
'@haverstack/adapter-api': patch
'@haverstack/record-adapter-sqlite': patch
---

Record-level permission grantees now discriminate on `kind` instead of `scope`, matching type-level grant grantees: `{ kind: 'entity', entityId }` and `{ kind: 'group', groupId, role }`. The shared arms are exported as `Grantee`, which replaces `PermissionGrantee`, with `GroupRole` naming `'member' | 'admin'`; `GrantGrantee` is `Grantee` plus `{ kind: 'authenticated' }`. The `GrantTarget` alias is removed in favor of `GrantGrantee`. Relationship targets (`RelationshipTarget`, `RelationshipTargetPattern`) move to `kind` too — `{ kind: 'record' | 'entity' | 'external', … }` — so an entity target and an entity grantee are the same value.
