---
'@haverstack/core': minor
---

Read a `_grant`'s `typeId` and `actions` as data at evaluation

A `_grant` Record reaching storage without passing `grant()` — an import, a
direct adapter write, a foreign server's response — carries whatever shape
it arrived with. Evaluation already read the grantee that way, asking for
its `kind` and refusing an empty `entityId`/`groupId`; it now asks the same
of the two fields beside it.

A `typeId` that is not a non-empty string names no family, and an `actions`
that is not a list names no verbs — the Record confers nothing rather than
conferring what a looser reading would produce. `actions` is the sharp one:
membership in a string is substring matching, so an `actions` of
`'delete-any read-any'` previously conveyed `delete-any` **and** found its
required read companion spelled in the same string. An entry the action
vocabulary does not hold is now dropped from a list that otherwise stands.

A grant naming no `typeId` also took every scoped read down with it rather
than conferring nothing: `query()` raised a `TypeError` out of the family
comparison for every requester, and a scoped subscription dropped events.

`revoke()` reads the stored list rather than the recognized one, so a grant
carrying an unrecognized action is not withdrawn by a target that omits it.
A malformed grant confers nothing and stays visible to `listGrants()`,
which is how an owner takes away something `grant()` never wrote.
