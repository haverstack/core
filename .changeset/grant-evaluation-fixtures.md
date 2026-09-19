---
'@haverstack/conformance-fixtures': minor
---

Pin the grantee arms and the evaluation-time refusals that the fixtures only described.

Two fixtures covered a grant with no grantee at all and a group arm with no role, and both said in prose that the other arms "are refused the same way" — a rule stated in a fixture and checked by nothing. Nine fixtures now stand behind it: each incomplete arm (`entity` with no `entityId`, `group` with no `groupId`), an empty `entityId` as distinct from an absent one, the listing-only `role: 'any'` that a `listGrants()` query may ask for and a stored grantee may never carry, an unrecognized `kind`, and a `null` grantee reported as the missing field it is rather than read as absent-then-defaulted.

Two more pin the half of the rule no request shape can show: that a grant reaching storage unvetted confers nothing when it is read back. A grant naming `_app@1` still answers 403 on a create, and a mutate verb with no read companion in the same grant conveys neither the write nor a read — so it answers 404, not 403. Both are states `grant()` refuses and a server mapping a request body, an import, or a foreign server's response can still produce.

Also pins that an `anyone` element labelled anything but `read` is refused, which is load-bearing beyond the element: stored, it would read as world read _and_ satisfy the `read` a `write` element needs beside it, silencing write-implies-read for every grantee on the record.

No behavior change — every rule here is already in `docs/spec/access-control.md`. A consumer holding these fixtures to a coverage gate will see the new names and need to dispatch or skip them.
