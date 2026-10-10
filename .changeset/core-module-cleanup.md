---
'@haverstack/core': minor
'@haverstack/conformance-fixtures': minor
---

Grantees are checked by one validator, whether they arrive as a permission element, in a `_grant` record, or as a `grantType()`/`listTypeGrants()`/`revokeType()` target:

- A permission element's grantee errors carry the failing field's path (`permissions[0].grantee.entityId` rather than `permissions[0].grantee`).
- A group grantee missing both `groupId` and `role` reports both problems, on every surface.
- A grant target's refusal is still a 400, now naming every problem after `Invalid grant target:`.
- Every grantee message ends with a period, like the other association messages. The `_grant` fixtures that pin these messages are updated to match.

`revokeType()` now matches a stored grant's actions as a set, so the order they were named in, or an action named twice, no longer stops a revoke from matching.
