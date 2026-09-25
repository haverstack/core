---
'@haverstack/core': minor
'@haverstack/adapter-api': minor
'@haverstack/conformance-fixtures': minor
'@haverstack/record-adapter-sqlite': patch
---

Replace the `hasAttachment` and `attachmentFileId` filters with `attachment: { label?, fileId? }`, shaped like `relatedTo`: at least one half is required, and both halves together match a single association. The wider "does this record reference the file" question — attachment associations plus top-level `file-ref` fields, used by `deleteAttachment()` and garbage collection — moves to `referencesFileId`. On the wire, `GET /records` takes `attachmentLabel`, `attachmentFileId` and `referencesFileId`. `assertValidRelatedTo` becomes `assertValidAssociationFilters(filter)`, which also refuses an empty `attachment` filter.
