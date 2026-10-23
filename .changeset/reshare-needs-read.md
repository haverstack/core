---
'@haverstack/core': minor
---

Resharing needs read on the Record. `editAccess()`, `setAccess()` and `setUnlisted()` refuse a creator who cannot read their Record — one removed from the roster that conveyed it, or a drop-box contributor. `permissions` and `unlisted` at `create()` are refused to a non-owner creator whose type grants would not let them read the Record.
