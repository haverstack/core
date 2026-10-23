---
'@haverstack/core': minor
---

Authority is gated the same way whenever it is written.

- Resharing needs read on the Record: `editAccess()`, `setAccess()` and `setUnlisted()` refuse a creator who cannot read their Record, such as one removed from the roster that conveyed it, or a drop-box contributor.
- `permissions` and `unlisted` at `create()` pass the same gate, asked of the Record the create would make.
- A roster entry no longer counts on the principal's side of a delegated request, so a delegated app neither manages a `_group` nor creates one, even with its own DID on the roster. The owner's own software acting for a subject still can.
