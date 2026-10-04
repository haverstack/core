---
'@haverstack/core': minor
---

`grantAccess()` and `revokeAccess()` throw `StackConflictError` on a soft-deleted record, like the other verbs that edit one.
