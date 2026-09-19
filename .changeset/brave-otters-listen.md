---
'@haverstack/core': minor
---

Make a Group's deletion withdraw it, and a grant's listing state decide nothing

Three lifecycle rules that authority resolution read differently from how
each family is withdrawn:

- **A soft-deleted `_group` Record carries no roster.** Every place a roster
  is resolved — a record-level `group` grantee, a group-targeted grant, and
  the coverage arm of `listGrants()` — now reads a tombstone as naming
  nobody, so deleting a Group withdraws what it conveyed and `undelete()`
  restores it, exactly as `revoke()`/`undelete()` work on a `_grant` Record.
  Group management still reads the roster off the Record it was handed, so
  an `admin` continues to hold a Group they deleted and can undelete it.
- **`_grant` Records are read with unlisted Records included.** Withholding
  a grant from enumeration no longer disarms it: listing state decides which
  queries enumerate a Record, never what it confers. `listGrants()` and
  `revoke()` read the same set, so an unlisted grant stays visible to the
  owner who wants to withdraw it.
- **An `anyone` element carries `read` or nothing.** One labelled otherwise
  was already refused at the write and is now read as naming no reach at
  evaluation too — it conveys no read of its own and does not satisfy the
  `read` a `write` element needs beside it.
