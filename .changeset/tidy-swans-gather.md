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

Each arm's own fields are required on every write, not only at the helper.
`create()`, `patchContent()`, `restoreVersion()` and `commitMigration()`
refuse a `_grant` whose `entity` arm carries no `entityId`, whose `group` arm
carries no `groupId` or role, or whose grantee names an unknown `kind`, with
`StackValidationError`. A closed `object` field holds one `properties` set,
so the schema can only require `kind`; without this an arm missing its own
field would store, answer 200, and deny forever.

`GrantTarget` is the same union, so the target passed to
`grant()`/`revoke()`/`listGrants()` is the grantee the record carries, and
`null` no longer does double duty as "default grant" and "default-only
listing". A group target matches whole, role included, so a revoke aimed at a
group's admins leaves its members' grant standing.

`listGrants()` takes a `GrantQuery` — the same union, widened by a
listing-only `role: 'any'` that returns every grant naming a group whichever
role it carries. `'any'` is not a role an entity can hold and never reaches
storage; `grant()` and `revoke()` reject it. Every arm but `entity` answers
identity — what `grant()` would have written with the same argument — while
the `entity` arm answers coverage, so its result is not a preview of what
`revoke()` would withdraw.

`revoke()` returns the grants it withdrew, as they stood, instead of `void`.
Matching nothing stays a no-op rather than an error — re-running a revocation
is safe — but the empty array now says so, where the silence did not.
