---
'@haverstack/core': patch
---

Harden the non-owner `_attachment@1` create carve-out so it no longer depends implicitly on `fileId`'s `kind: 'string'` schema declaration.

`hasReadableReference()` — shared by `canAccessFile()` and the carve-out that lets a non-owner add an additional `_attachment@1` metadata record without re-uploading bytes — now excludes `_attachment@1` records from matching outright, rather than relying on `fileId` not being a `file-ref` field to keep a requester's own prior metadata record from satisfying it. No observable behavior change: the carve-out already refused a requester's own prior record for the same `fileId`, this just makes that guarantee hold on its own terms instead of by way of a schema detail declared elsewhere.
