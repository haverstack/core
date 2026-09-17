---
'@haverstack/core': minor
'@haverstack/wire-types': minor
'@haverstack/adapter-api': minor
---

`associate()`/`dissociate()` events report what they moved

`RecordChange` gains `associationsAdded`/`associationsRemoved`, present
whenever `ops` includes `associate`/`dissociate`. Previously a subscriber
learned only that _some_ association changed — recovering which one, or
what an attachment association's `attachmentRecordId` changed to, meant
fetching the whole record.

Both fields report only what is true **now**, the same convention every
other field on `RecordChange` follows:

- `associationsAdded` is each association as it now stands, current
  annotation included — a re-point (a new `attachmentRecordId` on an
  association the record already held) surfaces here under its new value.
- `associationsRemoved` is identity only (`kind`/`label`, plus `fileId` for
  an attachment) — an attachment's `attachmentRecordId` is never repeated
  on removal, the same way a `purged` frame never carries the content it
  destroyed.

This does not make an association overwrite recoverable after the fact:
associations are never snapshotted (see the `associations-outside-versioning`
changeset), so a re-point's old `attachmentRecordId` still isn't retained
anywhere — these fields only let a subscriber who is listening at the
moment of the change observe it, in place of a fetch of the whole record.
Retroactive recovery is tracked separately.
