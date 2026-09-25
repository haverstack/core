---
'@haverstack/core': minor
'@haverstack/adapter-api': minor
---

`putAttachment()` on `Stack`, `ScopedStack` and `StackClient` takes an options object: `putAttachment(data, { mimeType, filename?, appId? })`, exported as `PutAttachmentOptions`. The adapter capability `putAttachmentWithMetadata(data, opts)` takes the same object, and `APIAdapter` implements it.
