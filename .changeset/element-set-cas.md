---
'@haverstack/core': minor
'@haverstack/record-adapter-sqlite': minor
'@haverstack/record-adapter-do-sqlite': minor
'@haverstack/adapter-conformance': minor
'@haverstack/adapter-local': patch
---

Association and permission writes are a compare-and-swap on the set they read, so concurrent edits can no longer leave a `_group` with no admin or a grantee holding `write` without `read`. `editAssociations`, `setAssociations`, `editAccess` and `setAccess` on `StackRecordAdapter` take an `expectSet` option (`ElementWriteOptions`) and throw `StackConflictError` when the stored set differs; `Stack` re-reads and re-checks on that conflict, and its journal delta is now computed against the set the write replaced. `sameAssociationSet` is exported from `@haverstack/core/adapter` for adapters to compare with.
