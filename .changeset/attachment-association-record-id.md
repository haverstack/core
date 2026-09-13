---
'@haverstack/core': minor
'@haverstack/record-adapter-sqlite': minor
'@haverstack/record-adapter-do-sqlite': minor
'@haverstack/conformance-fixtures': minor
---

Let an attachment association name the upload it came from, with an optional `attachmentRecordId`.

Attachments are content-addressed, but their metadata is per-upload: two byte-identical uploads share one `fileId` and get one `_attachment` record each. A `kind: 'attachment'` Association carried only `{ label, fileId }`, so two records referencing the same bytes were indistinguishable, and resolving a display name through `getAttachmentRecords(fileId)[0]` gave every one of them the _first_ uploader's filename.

`attachmentRecordId` names the `_attachment` record whose upload established a particular reference. It is optional, validated when written — the named record must exist, be in the `_attachment` family, and carry the association's own `fileId`, with one refusal for every way of failing so it is no existence oracle — and best-effort afterwards: the record it names can be deleted, and every reader falls back.

`resolveReferencedAttachment()` (exported from `@haverstack/core/wire`) applies the resolution order over the records `getAttachmentRecords()` returns: the named record, else the requester's own, else the first-recorded. A download has no reference to carry a pointer, so `GET /attachments/:fileId` resolves the last two steps and a client holding the association passes what it resolved as `?filename`.

The pointer stays outside association identity, which is still `(kind, label)` plus `fileId`. `dissociate()` matches without it, garbage collection and the `attachmentFileId` filter go on asking their `fileId`-level question, and an `associate()` naming a different one re-points the association already there — a version-bumping write, not a second reference to the same file. The association written is the association stored, so leaving the field off one that carries it clears it, rather than merging the old value forward. The SQLite adapters store it in a column outside the associations primary key and upsert on conflict.
