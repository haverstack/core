---
'@haverstack/conformance-fixtures': minor
---

The soft `DELETE` responses in `delete-record-soft` and `change-feed-deleted-frame-is-not-terminal` now carry the tombstone projection — `content: {}`, no authorship fields — as `docs/spec/versioning.md § The tombstone is literal` requires. A server built to the old bodies leaked the content a soft delete removes.
