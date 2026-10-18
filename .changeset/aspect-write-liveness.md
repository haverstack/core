---
'@haverstack/core': minor
'@haverstack/record-adapter-sqlite': minor
'@haverstack/record-adapter-do-sqlite': minor
'@haverstack/adapter-conformance': minor
---

Aspect writes (`setParent`, `setUnlisted`, `editAssociations`, `setAssociations`, `editAccess`, `setAccess`) never land on a record soft-deleted after `Stack` read it; such a write is now refused with `409`. `StackRecordAdapter`'s six aspect writes refuse a soft-deleted record inside the write, before `ifVersion` and `expectSet`, with the `StackConflictError` that `softDeletedRefusal()`, exported from `@haverstack/core/adapter`, builds.
