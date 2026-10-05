---
'@haverstack/core': minor
---

App installs: `Stack.planInstall()`, `installApp()` and `uninstallApp()` apply an app's manifest (its types and the grants it requests) as one reviewable act, stored as a new `_install@1` system type that cannot be granted and only the owner acting alone may write. An installed app may commit migrations within the type families its install claims, to versions the owner approved, when it holds `update-any` on them. `migrateAll()` takes `{ sweep: 'listed' }` for a non-owner and returns `{ migrated, skipped }`.
