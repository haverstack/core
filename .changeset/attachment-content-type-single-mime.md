---
'@haverstack/core': minor
---

Apply the attachment download safe-list to the whole `Content-Type` candidate, not a prefix of it. `isSafeAttachmentContentType()` now requires a single well-formed MIME type (`type/subtype` plus optional parameters), so a multi-type value such as `image/png,text/html` — which a browser resolves to its last type while a check stopping at the first `;` reads the first — is forced to `application/octet-stream` rather than served as-is.
