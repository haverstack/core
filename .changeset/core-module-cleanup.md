---
'@haverstack/core': minor
---

A permission element's grantee, a `_grant` record's grantee and a `grantType()`/`listTypeGrants()`/`revokeType()` target are now checked by one validator, so they report the same messages. A permission element's grantee errors now carry the failing field's path (`permissions[0].grantee.entityId` rather than `permissions[0].grantee`), and a group grantee missing both `groupId` and `role` reports both problems. `revokeType()` now matches a stored grant's actions as a set, so repeated actions no longer stop a revoke from matching.
