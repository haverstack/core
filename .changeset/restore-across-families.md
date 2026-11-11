---
'@haverstack/core': minor
---

Migrating a record is gated once on `ScopedStack`: only the owner acting alone, or an installed app migrating a live record within its own families, may do it. `commitMigration()` and a `restoreVersion()` of a snapshot from another family both pass the write gate and then this one, so write access in the family a record was migrated into no longer moves it back into a family the requester does not reach, and the destination family's binding fields are checked against the family being restored into. A restore within the family stays an ordinary write. `commitMigration()` now answers a requester who cannot read the record as for a missing one, as every other write does.
