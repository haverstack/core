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
its present. A plain reader gets `StackPermissionError`. `sinceSeq` and
`limit` are each held to a non-negative integer at the surface, before any
adapter sees them: left unchecked a negative `limit` diverged rather than
failing, dropping the newest entry on an in-memory log and lifting the
ceiling entirely on SQLite. Omitting `limit` still reads the whole log —
no ceiling is imposed, because the caller reconstructing an association's
full history is exactly who a silent truncation would betray.

`getJournal()` is declared on the `StackClient` interface alongside
`getVersions()`/`restoreVersion()`. Anyone implementing `StackClient`
outside this package must add it.

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

**Also fixes `createRecord` applying non-atomically** in the SQLite
adapters. It writes five statements — the record row, associations, the
full-text index, the content index and now a journal entry — and was the
only mutating method in the shared logic not wrapped in a transaction. A
failure partway left a records row behind while raising to the caller, so
a create that reported failure had half-succeeded, its retry failed on the
primary key, and the surviving row was invisible to `filter.search` and
mis-ordered by `sort.contentField` until something wrote it again.

The wire surface is not part of this change. `APIAdapter.getJournal()`
throws `APIAdapterCapabilityError` locally, before sending a request,
taking `subscribeChanges()`'s posture a step further: a subscription is
refused only against a server advertising no change feed, while a journal
read is refused against every server, there being no endpoint yet for any
of them to answer. That is why the method is on `StackClient` regardless —
a caller deserves a refusal naming the missing capability over a method
that isn't there.
