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

A Group that already holds an admin-less roster is not bricked. The post-state check permits
the write that repairs it — one naming the incoming admin — and refuses every write that
would leave it as it is.

What this does **not** promise is that an `admin` is _reachable_: an admin who loses their
key strands a Group as thoroughly as an empty roster would. The invariant closes an
accidental write, not the general problem of custody.

## A restore rolls back membership, not administration

The invariant has to hold without making any version unrestorable, and a post-state check on
`restoreVersion()` would have done exactly that — refusing a rollback to a snapshot that was
legal when it was taken.

So on a `_group` Record, **`member` associations restore from the snapshot like any other
association, while `admin` entries carry forward from the record as it currently stands.**
This is the stance restore already takes on `permissions`, applied to the roster entries that
are authority rather than data: silently reshuffling who administers a Group as a side effect
of rolling back its display name is the same surprise the permissions rule exists to avoid —
and rolling _forward_ is the worse half of it, since a restore of old content would otherwise
re-grant management to an admin who had been deliberately removed.

Every version stays restorable, including one taken when the roster had no admin: the admins
such a restore must produce are the ones the record already has. Recovering a _former_ admin
set is a deliberate `associate()`, which is the point.

## Adapters

`StackRecordAdapter.restoreVersion()` gains an optional **`associations`** in `opts`: the
association list to apply in place of the target snapshot's, already resolved by the caller.
An adapter writes the list it is handed and falls back to the snapshot's when handed none —
it needs no knowledge of `_group` or of roster labels, which keeps the rule in core where the
record's meaning is known. This is the only reason the key exists; `Stack.restoreVersion()`
is its only caller.

`@haverstack/adapter-api` deliberately does not send it. The wire protocol has no field for
it and needs none: the server runs the same `Stack` logic over its own adapter and resolves
the identical list from the identical record. A wire field would let a client _propose_ that
list instead, which is the one thing the rule exists to prevent.

`ScopedStack.restoreVersion()`'s reference-creation gate now runs against the associations a
restore will actually apply rather than the snapshot's — a `_group`'s carried-forward `admin`
entries are already on the record, so they create no reference to gate, on the same reasoning
that leaves a `parentId` the restore would not change un-regated.
