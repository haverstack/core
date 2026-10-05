---
'@haverstack/core': minor
---

An installed app's `commitMigration()` is held to the file-reference gate. Requests compare as sets of actions, and a plan that changes only `name` or `version` is no longer empty.
