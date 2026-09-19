---
'@haverstack/core': minor
'@haverstack/conformance-fixtures': minor
---

Spell a Grant's reach affirmatively, in a required `grantee`

`GrantContent.granteeEntityId`/`granteeGroupId` are replaced by one required
`grantee` discriminated on `kind`: `{ kind: 'entity', entityId }`,
`{ kind: 'group', groupId, role }`, or `{ kind: 'authenticated' }` for any
authenticated entity. The tier is read off the discriminant, so no dropped
field widens a grant's reach — a `_grant` Record arriving without a grantee
fails schema validation instead of becoming a grant to everyone, and one
carrying an unknown `kind` or an empty `entityId`/`groupId` confers nothing
however it reached storage. Mutual exclusivity is a property of the type
rather than a documented convention.

`role` is required on the group arm, matching the record-permission side:
`role: 'member'` is the wider set — an admin satisfies it — and
`role: 'admin'` the narrower.

The two "everyone" tiers reach different audiences and now share no word. A
Grant's `{ kind: 'authenticated' }` reaches any entity holding a DID; a
Record permission's `{ kind: 'anyone' }` reaches anonymous requesters too.

`GrantTarget` is the same union, so the target passed to
`grant()`/`revoke()`/`listGrants()` is the grantee the record carries, and
`null` no longer does double duty as "default grant" and "default-only
listing". A group target matches whole, role included, so a revoke aimed at a
group's admins leaves its members' grant standing.
