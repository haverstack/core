---
'@haverstack/core': minor
'@haverstack/record-adapter-sqlite': minor
'@haverstack/conformance-fixtures': minor
'@haverstack/adapter-api': minor
---

Relationship associations carry a discriminated `target` instead of a bare `recordId`

A relationship's target now names which identifier space its value belongs to:
`{ scope: 'record', recordId, stackUrl? }` for a Record here or in another stack,
`{ scope: 'entity', entityId }` for a DID, and `{ scope: 'external', ns, id }` for
anything outside the stack — an ATProto post, an ActivityPub actor, an email address,
a URL. Core expresses the reference and never dereferences it, so no protocol is
privileged.

The `entity` arm closes a gap in the identity model rather than only enabling external
references: group rosters stored member DIDs in a field typed `RecordId`, and the
permission path compared the two as plain strings. A roster entry carrying a `record`
target now confers nothing, even when its value equals a member's DID.

`RecordFilter.relatedTo` moves with it. It names a label, a target, or both, and each
is a pattern: a bare `label` matches every target under it, and an external target with
no `id` matches a whole namespace. A `record` target with no `stackUrl` matches only
local targets — absence names this stack rather than acting as a wildcard. Label-only
and namespace-wide queries were not expressible before. "Carries any relationship at
all" is deliberately not expressible, in line with `tags` and `hasAttachment`, which
have no match-any form either.

Reference-creation gating now applies only to a relationship naming a Record in this
stack; the other arms name nothing core can resolve, so there is no access for the
gate to protect. The SQLite association table gains `related_scope`, `related_ns` and
`related_stack` columns, all part of the primary key — so two copies of one record on
two networks are two associations rather than a silent no-op. Existing stack files
predate those columns and must be recreated.

Over the wire, the relationship filter's scope is implied by which parameters appear
(`relatedTo`/`relatedToStack`, `relatedToEntity`, or `relatedToNs`/`relatedToId`), and
a request mixing scopes is rejected with 400. At least one is always present, so the
filter cannot encode to an empty query string and widen the query it meant to narrow.
