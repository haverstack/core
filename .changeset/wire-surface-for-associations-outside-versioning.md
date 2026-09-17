---
'@haverstack/conformance-fixtures': minor
---

Pin the wire surface for associations outside versioning

The wire spec and fixtures now state what associations outside version
history mean for a server implementation, which is where they are read from:

- **A snapshot body carries no `associations`**, and a restore leaves a
  record's associations where they stand. `WireVersion` has no such field,
  so a server emitting one writes a key every client drops — and a server
  that snapshots on the association endpoints hands every later restore a
  stale set to put back. A new fixture,
  `get-versions-after-associate-is-unchanged`, pins that
  `GET /records/:id/versions` answers identically across an `associate()`,
  and the conformance run asserts no parsed snapshot names an association
  set.
- **The change feed's own document describes the association fields.** Its
  frame examples spell `ops` as the list it is, one of them carries
  `associationsAdded`, and the implementation checklist names the two
  association endpoints — a server emitting off its snapshot path alone
  serves no association events at all, and the checklist previously pointed
  only at the list of endpoints that bump `version`.

- **An `If-Match` sent to an association endpoint is ignored, not refused.**
  The endpoints read no precondition, so there was nothing for the
  spec's "a malformed `If-Match` is 400" rule to protect there, and it
  said only that the endpoints "take no `If-Match`" — which a server could
  as easily have implemented as a rejection. They never look at the header,
  whatever its value. A `PATCH` naming `associations` alone still earns the
  400 for a malformed one: that route reads the header and finds it
  unreadable, where the association endpoints never look. The conformance
  run now asserts the client half — `APIAdapter` sends no `If-Match` on
  either endpoint.

`restore-version` and `change-feed-changed-frame-names-the-verb` had
descriptions naming a restore's association set and a singular `op`; both
now say what the endpoints do.
