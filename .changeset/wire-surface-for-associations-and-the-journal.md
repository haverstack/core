---
'@haverstack/conformance-fixtures': minor
---

Pin the wire surface for associations outside versioning, and for the journal

The wire spec and fixtures now state what the association and journal tiers
mean for a server implementation, which is where the two are read from:

- **A snapshot body carries no `associations`**, and a restore leaves a
  record's associations where they stand. `WireVersion` has no such field,
  so a server emitting one writes a key every client drops — and a server
  that snapshots on the association endpoints hands every later restore a
  stale set to put back. A new fixture,
  `get-versions-after-associate-is-unchanged`, pins that
  `GET /records/:id/versions` answers identically across an `associate()`,
  and the conformance run asserts no parsed snapshot names an association
  set.
- **The change journal has no endpoint in this protocol version.** Wire
  format § Versions now says so, and says why `getJournal()` over
  `APIAdapter` refuses against every server rather than only one
  advertising nothing: an empty log has to mean "nothing changed"
  unconditionally, so "this server does not remember" must not be able to
  spell itself the same way.
- **The change feed's own document describes the association fields.** Its
  frame examples spell `ops` as the list it is, one of them carries
  `associationsAdded`, and the implementation checklist names the two
  association endpoints — a server emitting off its snapshot path alone
  serves no association events at all, and the checklist previously pointed
  only at the list of endpoints that bump `version`.

`restore-version` and `change-feed-changed-frame-names-the-verb` had
descriptions naming a restore's association set and a singular `op`; both
now say what the endpoints do.
