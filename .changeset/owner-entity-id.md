---
'@haverstack/core': minor
'@haverstack/wire-types': minor
'@haverstack/conformance-fixtures': minor
'@haverstack/adapter-api': minor
'@haverstack/record-adapter-sqlite': minor
'@haverstack/record-adapter-do-sqlite': minor
---

The stack owner has one name wherever a field can only hold the owner: `ownerEntityId`.

- `_config`'s content is `{ ownerEntityId, timezone }`, and `ConfigContent.entityId` is `ConfigContent.ownerEntityId`.
- The discovery response (`GET /.well-known/stack`) carries `ownerEntityId` in place of `entityId`, in `DiscoveryResponse` and the discovery fixtures. The `_config` ownership-conflict fixture is `error-conflict-config-owner-change`.
- Fields that may hold any entity, such as a relationship target or a grantee, keep `entityId`.
