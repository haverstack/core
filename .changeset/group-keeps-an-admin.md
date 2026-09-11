---
'@haverstack/core': minor
'@haverstack/adapter-api': minor
'@haverstack/adapter-local': minor
'@haverstack/record-adapter-sqlite': minor
'@haverstack/record-adapter-do-sqlite': minor
---

A group keeps at least one admin

**"A `_group` Record's roster carries at least one `admin`" becomes an invariant of the
Record rather than a convenience at create time.** `stampGroupAdmin()` already made the
creator the first admin, and `identity.md` already promised that "no Group is ever
management-orphaned" — but nothing re-asserted it on a subsequent write, so a roster could
be emptied and the Group left manageable by the stack owner alone.

Any write that would leave the roster with no `admin` is now refused with
`StackConflictError` (wire: 409), whether it arrives through a change set's `associations`,
which replaces the roster wholesale, or through `dissociate()`, which removes one entry.

```ts
// Refused: nothing would be left to manage the group.
await stack.mutate(group.id, { associations: [] });

// Fine: an admin may step down while another remains.
await stack.dissociate(group.id, { kind: 'relationship', label: 'admin', target: me });
```

**The check reads the roster the write would produce, not the one it started from.** That is
what makes it precise without special cases: an `admin` may remove themselves while another
remains, and may not remove the last one, and neither case needs to name who is being
removed. It is also the one place a change-set check reads the post-state — the rule is
about what a write leaves behind rather than about what the caller named.

**The stack owner does not bypass it.** They can already manage any Group, so the rule costs
them nothing they wanted, and a bypass would mean nothing downstream could rely on the
invariant. It therefore lives in `Stack` alongside the other integrity constraints rather
than in `ScopedStack`'s group gate: who may write a `_group` is a permission question, and
this is not one.

Taken with the restore rule below, the three together close the invariant by construction:
every `_group` holds an admin from its first version, no write takes a roster to zero, and no
restore moves a roster at all. An admin-less roster is not a state the API can reach. Because
the check reads the post-state it would still behave correctly on one manufactured by a
direct adapter write — permitting a write that names an incoming admin, refusing one that
does not — but that falls out of the framing rather than being a repair path the rules
promise.

What this does **not** promise is that an `admin` is _reachable_: an admin who loses their
key strands a Group as thoroughly as an empty roster would. The invariant closes an
accidental write, not the general problem of custody.

## A restore does not roll back a Group's roster

On a `_group` Record, `content` and `parentId` roll back as they do anywhere, and the
Record's **`associations` are left exactly as they stand** — the snapshot's are not put back,
and the current ones are not taken away.

This is the stance restore already takes on `permissions`, applied to the whole roster on the
grounds that a roster is authority rather than data. A Group's `member` and `admin` entries
are what group ACLs and group-targeted grants resolve against, so rolling either half back
silently re-grants access as a side effect of a verb the caller asked for its content:
management to an `admin` who had been deliberately removed, reach to a `member` who had been
dropped. Recovering a former roster is a deliberate `associate()`, which is the point.

It is also what lets the invariant hold here without a check. A restore cannot move a roster,
so it cannot be the write that empties one, and no version of a `_group` is unrestorable on
that ground.

## Adapters

`StackRecordAdapter.restoreVersion()` gains an optional **`restoreAssociations`** in `opts`.
`false` rolls back everything but the associations, leaving the record's current list where
it stands; absent or `true` applies the snapshot's, as before. An adapter needs no knowledge
of `_group` or of roster labels, which keeps the rule in core where the record's meaning is
known. `Stack.restoreVersion()` is its only caller.

No association list travels to an adapter, which is deliberate: there is no list resolved
above the adapter and written below it, so nothing a restore writes can disagree with what
the record already holds, and no read-then-write window exists for a concurrent roster change
to be undone through.

`@haverstack/adapter-api` does not send it. The wire protocol has no field for it and needs
none: the server runs the same `Stack` logic over its own adapter and reaches the same answer
from the same record. A wire field would only let a client _propose_ that answer.

`ScopedStack.restoreVersion()`'s reference-creation gate skips a `_group` Record's
associations entirely — a restore does not move the roster, so it introduces no association
to gate, on the same reasoning that leaves a `parentId` the restore would not change
un-regated.
