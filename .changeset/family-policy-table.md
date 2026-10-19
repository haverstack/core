---
'@haverstack/core': patch
---

Hold `ScopedStack`'s system-family rules in one table that every write verb consults, so the `_app` binding and owner-DID fences are asked of `create()`, `patchContent()`, `restoreVersion()` and `commitMigration()` alike.
