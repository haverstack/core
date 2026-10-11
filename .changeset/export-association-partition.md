---
'@haverstack/core': minor
---

Export `isAuthorityAssociation` from `@haverstack/core`, for apps that split a journal entry's association changes between `amendAssociations()` and `amendAccess()`, and `partitionAssociations` and `AUTHORITY_ASSOCIATION_KINDS` from `@haverstack/core/adapter`, for storage engines that keep both halves in one table.
