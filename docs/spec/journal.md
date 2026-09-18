# Change journal

**The second durable tier a mutation writes, beside [version history](./versioning.md#version-history): what each change moved, who moved it, and the association deltas nothing else retains.** A snapshot answers _what could be put back_; a journal entry answers _what happened_. Content needs only the first, because its prior state is in the snapshot. Associations need the second, because theirs is nowhere.

This document is the model and the local API. Its wire encoding — `GET /records/:id/journal`, its paging and its refusals — is [Wire format § Journal](./wire-format.md#journal).

## Why the tier exists

[Associations are invertible](./versioning.md#version-history) — the inverse of an `associate()` is a `dissociate()` of the same shape — but invertibility is not recoverability: an inverse exists, and deriving _which_ inverse takes the prior state. A subscriber watching the [change feed](./events.md) at the moment of the write sees the delta go past; the journal is where anyone who was not listening reads it afterwards. A feed is a notification, not a store — widening it into one is [the wrong answer](./events.md#what-a-feed-is-not) to this question, because a replayable feed would have to re-decide readability long after the record it describes has moved on, and would keep naming records a hard delete destroyed.

## The entry

```ts
type RecordJournalEntry = {
  seq: number; // dense from 1, per record — the entry's only ordering
  at: Date; // when the entry was appended
  kind: ChangeKind;
  ops: ChangeOp[];
  version: number; // the version this change produced; unchanged on associate/dissociate
  typeId: TypeId;
  parentId?: RecordId; // where the record sat after the change; absent = the root
  previousParentId?: RecordId | null; // present on a move; `null` = off the root
  actor?: ChangeActor;
  associationsAdded?: Association[];
  associationsRemoved?: Association[]; // identity only, as on the feed
  associationsReplaced?: Association[]; // the association an associate() overwrote in place
};
```

**`associationsReplaced` is the one field with no counterpart on the feed.** Re-pointing an `attachmentRecordId` overwrites the old value, and the feed reports only what is [true now](./events.md#the-event-shape). The journal keeps what it replaced, which is what makes a re-point undoable rather than merely observable. See [Attachments § Naming the upload a reference came from](./attachments.md#naming-the-upload-a-reference-came-from).

An entry names _that_ a permission set moved, never what it moved to — the sharing graph stays on the record and on its snapshots. That is why there is no `permissions` stripping to do here, unlike on a snapshot.

## The entry set is the event set

**Every write that [emits](./events.md) appends exactly one entry, and no other write appends one** — so a no-op appends nothing, for the same reason it emits nothing, and a change set naming three aspects is one entry naming three `ops`. The journal and the feed report the same change; they differ in how long the answer is available.

It is one rule rather than two lists because the two halves are built from one object: `Stack` names a change once — its ops, its kind, its actor, what it moved — and hands the durable half to the adapter and the live half to the emitter. A verb cannot journal one thing and announce another, and the [hard-delete exception](#a-hard-delete-destroys-the-journal) below is a property of that object rather than a rule each call site remembers.

**`putAttachment()` over an adapter that writes bytes and metadata together is the one emission with no local entry**, exactly as [`saveVersion()` is the one snapshot `APIAdapter` does not write](./versioning.md#snapshot-atomicity): the record was created on the far side, so the entry was appended there, in that same write. The division is the same one the whole adapter draws — a server is the only writer of its own durable tiers — and no adapter that stores records locally has a case like it.

## Ordering

**`seq` is dense from 1 per record, and is the entry's only ordering.** `at` is wall clock, and `version` stands still across an association change, so neither orders the log alone.

It is allocated by the adapter inside the appending write, from the log's own maximum — never computed by `Stack` from a value it read earlier. That is why the journal needs none of the collision healing [a snapshot needs](./versioning.md#snapshot-atomicity): no writer ever holds a `seq` it expects to still be free.

It is **not** the [change feed's `seq`](./change-feed.md#frames), which is an opaque server-minted cursor over the whole stack. The two share a name because both order a stream, and no value may be carried from one to the other.

## Atomicity

**An entry lands in the same atomic write as the mutation it describes.** Adapters accept it as an option on every mutating method — `associate()`/`dissociate()` included, which take no other — and append it inside their own transaction, after the write, reading `version`, `typeId` and `parentId` off the row it produced. `Stack` supplies only the half the record cannot report afterwards. A crash cannot leave a change unjournaled, and a failed mutation leaves no entry.

## A hard delete destroys the journal

Exactly as it destroys version history. A log naming what a purged record held — its tags, its containers, who touched it — is precisely the residue [the erasure primitive](./versioning.md#deletion) exists to leave nothing of. So the journal never records a purge: the entry and the record go together. Soft delete keeps it, because a tombstone is recoverable and its journal is part of what recovers it.

## Reading it

- `stack.getJournal(recordId, { sinceSeq?, limit? })` — the log, oldest first.

`sinceSeq` and `limit` are each a non-negative integer or absent; anything else is refused with `StackQueryError` before an adapter sees it. The window is checked rather than coerced because the two coercions available disagree: a negative `limit` read as a JavaScript slice drops the newest entry, and read as a SQL `LIMIT` removes the ceiling altogether. **Omitting `limit` reads the whole log, and no ceiling is imposed when it is omitted** — unlike a query, where a default page size is a kindness, a truncated journal is a wrong answer to the one caller who needs it, the one reconstructing an association's full history.

**Gated on the mutate surface, exactly as [history is](./versioning.md#history-access), and for the same reason.** A log of who changed what, gated on current read access, would make a record's past exactly as reachable as its present — the retroactivity that rule exists to prevent. An association label is content enough to matter: gaining read access today is not an entitlement to the trail of every tag the record has ever carried. A write-holder, the owner, or a creator passes; a plain reader gets `StackPermissionError`, the same answer `getVersions()` gives.

**Every adapter implements `getJournal()` — it is not an optional method.** An adapter with no journal to read refuses the call; it does not decline to have it. "Nothing changed" and "this stack does not remember" are not the same answer, and a caller reconstructing an association's history cannot tell them apart, so an empty log has to mean the first unconditionally. That is what makes [the wire endpoint](./wire-format.md#journal) mandatory rather than a capability a server advertises: the alternative spelling available to a server with no journal is an empty log, which is the one answer it must not give. A subscription is refused against a server advertising no feed because [a feed is a live connection](./change-feed.md#advertising-it) a client can be told up front it will not get; a log is a question with a wrong answer, so the endpoint is required of everyone instead.

**Reading it over the wire is paged; reading it locally is not.** A server may answer a page shorter than the `limit` asked for, and says so with a cursor — necessary, since omitting `limit` asks for an unbounded read. `APIAdapter.getJournal()` follows that cursor to the end, so the contract above holds identically whatever page size a server picks, and no caller has to know which adapter it is on. See [Wire format § Journal](./wire-format.md#journal).

## Why this is not more duplication

The stack materializes a record's data in four places, and they divide cleanly in two:

| Store           | Rebuildable from `records`? | What it is        |
| --------------- | :-------------------------: | ----------------- |
| `content_index` |             Yes             | An index          |
| `records_fts`   |             Yes             | An index          |
| `versions`      |             No              | A source of truth |
| `journal`       |             No              | A source of truth |

An index can be dropped and regenerated; it costs disk and write amplification and nothing else, and it is never what a recovery path reads. A source of truth cannot be regenerated, so it owes the full treatment: an erasure path that reaches it, a permission gate of its own, and a retention story.

The journal is the cheapest of the four to carry, because it is **envelope-level**: `content` lives on a snapshot, and copying it here would make the journal the larger of the two stores for a recovery nobody asked for. A record's snapshot holds a full copy of its content per version, which is where a stack's history bytes actually are; an entry holds a verb, an actor and a delta.

Both untracked stores grow with write volume and neither prunes itself. That is a policy question this spec does not answer for `versions`, and does not answer here either.
