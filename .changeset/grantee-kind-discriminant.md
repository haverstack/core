---
'@haverstack/core': minor
'@haverstack/conformance-fixtures': minor
'@haverstack/adapter-conformance': patch
'@haverstack/record-adapter-sqlite': patch
---

Record-level permission grantees now discriminate on `kind` instead of `scope`, matching type-level grant grantees: `{ kind: 'entity', entityId }` and `{ kind: 'group', groupId, role }`. The shared arms are exported as `Grantee`, with `GroupRole` naming `'member' | 'admin'`; `PermissionGrantee` is `Grantee` and `GrantGrantee` adds `{ kind: 'authenticated' }`. `GrantTarget` is removed — `grant()` and `revoke()` take a `GrantGrantee`. Relationship targets keep `scope`.
