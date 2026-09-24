---
'@haverstack/core': minor
'@haverstack/adapter-api': minor
---

`Stack.grant()` and `Stack.revoke()` now take the subject first and the grantee inside the element, mirroring `grantAccess(id, permission)`: `grant(typeId, { actions, grantee })` creates and returns one `_grant` record, and `revoke(typeId, { actions, grantee })` returns the grants it withdrew. The batch form is removed — call `grant()` once per type. The element type is exported as `TypeGrant`.

`putAttachment()` on `Stack`, `ScopedStack` and `StackClient` takes an options object: `putAttachment(data, { mimeType, filename?, appId? })`, exported as `PutAttachmentOptions`. The adapter capability `putAttachmentWithMetadata(data, opts)` takes the same object, and `APIAdapter` implements it.
