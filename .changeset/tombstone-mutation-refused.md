---
'@haverstack/core': minor
---

`Stack.mutate()`, `patchContent()`, `associate()`, `dissociate()` and `restoreVersion()` throw `StackConflictError` on a soft-deleted record, as `ScopedStack` already did. Call `undelete()` first.
