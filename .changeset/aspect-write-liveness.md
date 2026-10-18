---
'@haverstack/core': minor
'@haverstack/record-adapter-sqlite': minor
'@haverstack/record-adapter-do-sqlite': minor
'@haverstack/adapter-conformance': minor
---

Aspect writes (`setParent`, `setUnlisted`, `editAssociations`, `setAssociations`, `editAccess`, `setAccess`) never land on a record soft-deleted after `Stack` read it; such a write is now refused with `409`. `StackRecordAdapter`'s six aspect writes take an `expectLive` option and throw `RecordMovedError` on a tombstone, checked inside the write; `Stack` always passes it and re-reads on that error. `ElementSetMovedError` is renamed `RecordMovedError`, since it now covers both checks.
