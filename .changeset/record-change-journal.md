---
'@haverstack/core': minor
'@haverstack/record-adapter-sqlite': minor
'@haverstack/record-adapter-do-sqlite': minor
'@haverstack/adapter-api': minor
'@haverstack/adapter-local': minor
---

A durable change journal, beside version history

**Every write that emits a change event now also appends one entry to the
record's journal** — a second durable tier holding what the change moved,
who moved it, and the association deltas nothing else retains.

A snapshot answers _what could be put back_; a journal entry answers _what
happened_. Content needs only the first, because its prior state is in the
snapshot. Associations need the second, because theirs is nowhere: the
inverse of an `associate()` is a `dissociate()` of the same shape, but
deriving _which_ inverse takes the prior state, and until now that state
reached the change feed and nowhere else.

```ts
await stack.associate(note.id, { kind: 'tag', label: 'draft' });
await stack.dissociate(note.id, { kind: 'tag', label: 'draft' });

// Days later, in a process that was never subscribed:
for (const entry of await stack.getJournal(note.id)) {
  entry.ops; // ['associate'] / ['dissociate']
  entry.associationsAdded; // the association, as it stood
}
```

`associationsReplaced` is the one field with no counterpart on the feed:
re-pointing an `attachmentRecordId` overwrites the old value, and a frame
reports only what is current. The journal keeps what it replaced, which is
what makes a re-point undoable rather than merely observable.

**`stack.getJournal(recordId, { sinceSeq?, limit? })` is gated on the
mutate surface, exactly as `getVersions()` is.** A log of who changed what,
gated on current read access, would make a record's past as reachable as
its present. A plain reader gets `StackPermissionError`.

**A hard delete destroys the journal, exactly as it destroys version
history** — so the journal never records a purge.

**Adapter contract:** every mutating `StackRecordAdapter` method takes
`opts.journal`, and `associate()`/`dissociate()` take an options object for
the first time since they stopped bumping. Adapters append the entry inside
the same write as the mutation, stamping `seq`, `at`, `version`, `typeId`
and `parentId` from the row they just wrote — `Stack` supplies only the
half a record cannot report afterwards. `seq` is allocated by the adapter
from the log's own maximum, so unlike a snapshot's caller-computed version
number there is no collision to heal. `getJournal()` is **required** on
the interface, not optional: an adapter with no journal to read refuses
the call rather than declining to have the method, so an empty log always
means "nothing changed" and never "this stack does not remember".

The wire surface is not part of this change. `APIAdapter.getJournal()`
throws `APIAdapterCapabilityError` locally, before sending a request — the
same posture `subscribeChanges()` takes against a server advertising no
change feed.
