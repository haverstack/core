---
'@haverstack/core': minor
'@haverstack/conformance-fixtures': minor
---

`associate()`, `dissociate()`, `grantAccess()` and `revokeAccess()` take arrays, each call one atomic write and one journal entry, and `amendAssociations()` / `amendAccess()` apply a list of adds and removes as one write. Granting edit access is `grantAccess(id, [read, write])`; `write` never implies `read`. `repoint` is refused as input.
