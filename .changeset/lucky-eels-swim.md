---
'@haverstack/wire-types': minor
---

Add the change-feed wire types: `WireRecordChange` and `serializeChange()`, the `ready`/`record`/`reset` frame names and their payloads, `DiscoveryChanges` with `supportsChangeFeed()`, and `isValidSeq()` for the cursor charset.

`serializeChange()` drops the record, its parent, and everything else identifying it from a `purged` frame, whatever the caller passes. A server holds the purged record at emission — readability can only be evaluated before the write — so enforcing the rule in the encoding puts it where the leak would otherwise start.
