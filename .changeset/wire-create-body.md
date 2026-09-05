---
'@haverstack/core': minor
---

Add `createOptionsFromWireRecord()` to `@haverstack/core/wire`

`POST /records` is the one endpoint where a client sends a whole record and
the server may trust only part of it, and the three dispositions its fields
take — stamped, conditionally dropped, forwarded — are not derivable from a
field's name. A server got them right by naming each field it wanted and
never reading `entityId`, which nothing enforces: the obvious
`create(body.typeId, body.content, { ...body })` forwards a self-reported
`entityId` and `principalId`, has no symptom, and passes every fixture.

The helper takes a body, a `TokenSession` and the owner's DID, and returns
the `typeId`, `content` and options `ScopedStack.create()` takes.
`entityId` and `principalId` are absent from the returned type rather than
merely unread. `createdAt`/`updatedAt` are dropped by value for anyone but
the owner acting alone — every client sends both on every create, so
forwarding them unfiltered turns an ordinary grantee create into a `403`.
`unlistedAt` becomes `unlisted: true` for everyone, leaving the refusal to
`ScopedStack`.

`isOwnerActingAlone()` is exported beside it and now backs `ScopedStack`'s
own owner-only gates, so the tier a server applies to a session and the one
core enforces are one definition. A server needs it for hard delete,
`commitMigration()` and `includeUnlisted` regardless.

A present field whose value is the wrong shape is refused rather than
dropped: a dropped `id` mints a different record than the one the client
asked for, and a dropped `unlistedAt` publishes one the client meant to
withhold. Which error class says so follows whether the failure names a
field of the record being written — `StackQueryError` (400) for a body that
is not a create request at all, `StackValidationError` (422), carrying the
path, for one that is.
