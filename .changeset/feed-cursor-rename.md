---
'@haverstack/core': minor
'@haverstack/wire-types': minor
'@haverstack/adapter-api': minor
'@haverstack/conformance-fixtures': minor
'@haverstack/record-adapter-sqlite': patch
'@haverstack/adapter-conformance': patch
---

Rename the change feed's resume cursor from `seq` to `cursor`, so it no longer shares a name with the journal's per-record `seq`. `RecordChange.seq` is now `RecordChange.cursor`, the `ready` frame carries `{"cursor": …}`, and `isValidSeq()` is now `isValidCursor()`. The journal window's exclusive bound `JournalQuery.sinceSeq` (and the `?sinceSeq=` query param) is now `afterSeq`.
