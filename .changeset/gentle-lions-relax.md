---
'@haverstack/core': minor
---

Add `getEntityByDid()` and `getOwnerEntity()` to `StackClient`, resolving a DID to its `_entity` card with the rules that make the answer single-valued: family-wide by `baseId` (so a card migrated to a later type version still resolves), including soft-deleted cards (which still reserve their `did`), and matched in memory when the adapter doesn't declare `contentFieldQuery`. Every caller that needed this lookup was re-deriving it, and two existing implementations (`Stack.ensureOwnerEntity()` in this repo, `entityRoutes`'s `resolveOwnerRecordId()` in the server) disagreed on the rules.

`getOwnerEntity()` is `getEntityByDid()` for the one DID every stack reserves — the owner's own, named by `ownerEntityId`.

Under `ScopedStack`, the result is filtered to what the request may read, and `includeUnlisted` is honored only for the owner acting alone — matching what `query()` itself permits rather than throwing. `null` therefore covers three cases that share one answer (missing, unreadable, or unlisted-and-not-permitted) and is never evidence a card is absent, per the anti-oracle rule.

`Stack.ensureOwnerEntity()`'s bootstrap probe is now implemented in terms of `getEntityByDid()`, so there is one lookup rather than two.
