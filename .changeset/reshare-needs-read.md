---
'@haverstack/core': patch
---

Resharing (`editAccess()`, `setAccess()`, `setUnlisted()`) needs read on the Record, like every other mutation, so a creator removed from the roster that conveyed their read can no longer reshare their Record to grant themselves back in.
