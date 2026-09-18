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
  associations?: AssociationChange[]; // one tagged edit per association the write moved
};

type AssociationChange =
  | { op: 'add'; association: Association }
  | { op: 'repoint'; association: Association; previous: Association }
  | { op: 'remove'; previous: Association };
```

**`associations` is the field with no counterpart on the feed, and it is shaped for this tier rather than borrowed from that one.** [A frame](./events.md#the-event-shape) carries two flat lists of what is true now, which is the right answer to "what just happened" and the wrong one to "what did it happen to": a list of prior states beside a list of current ones has no join key, and `(kind, label)` is not identity — one record holds two `cover` attachments for different files. So the journal carries the prior state **on the element that displaced it**, and every inverse is local to one edit.

- **`add`** — an association the record did not hold under this identity.
- **`repoint`** — an `associate()` that landed on an identity already there, overwriting its annotation in place. `previous` is the only durable record of the `attachmentRecordId` it discarded. See [Attachments § Naming the upload a reference came from](./attachments.md#naming-the-upload-a-reference-came-from).
- **`remove`** — a dissociate. `previous` is the association **in full**, annotation included, which is what makes a removal as undoable as a re-point. A frame names identity only here, because a notification reports what is current; a log whose whole argument is prior state does not.

`ops` still carries `associate`/`dissociate` — `associate` when any element is an `add` or a `repoint`, `dissociate` when any is a `remove` — so the coarse branch reads the same on an entry as on a frame.

**An association list holds distinct identities**, so no entry ever names one identity twice. That is enforced where every other change-set rule is, in the invariant layer: a list naming one identity twice describes a state no store can hold, and is refused rather than collapsed. See [Data model § Associations](./data-model.md#associations).

### The inverse

Undoing one entry's association change is a walk over `associations`, with no lookup into a sibling list:

```ts
for (const change of entry.associations ?? []) {
  if (change.op === 'add') await stack.dissociate(recordId, change.association);
  else await stack.associate(recordId, change.previous);
}
```

A `repoint` and a `remove` invert identically — `associate(previous)` puts an association back whether it was overwritten or taken away — and an `add` is dropped. Nothing here asks which element of one list matched which element of another, which is the property the shape exists for.

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

**The log _of_ the purged record.** Exactly as it destroys that record's version history. A log naming what a purged record held — its tags, its containers, who touched it — is precisely the residue [the erasure primitive](./versioning.md#deletion) exists to leave nothing of. So the journal never records a purge: the entry and the record go together, and `kind` has no `purged` value to write. Soft delete keeps it, because a tombstone is recoverable and its journal is part of what recovers it.

**Entries on _other_ records that name the purged id survive**, and are not cleaned up. A record that was moved out of the purged container, or that holds a relationship to it, or whose attachment reference was annotated with its id, carries that id in its own log — that is the other record's history, authored by its writer and gated on its own mutate surface. The purged id also stands in those records' live `parentId`s and association rows, which [Data model § Reparenting](./data-model.md#reparenting) already accepts as ordinary state at rest, so the entry discloses nothing the current state does not. Chasing it would mean a reverse index over every record's log, and rewriting entries would break the one property the tier rests on: an entry says what a write did, and nothing edits it afterwards.

A purged record's id is therefore a pointer to nothing, wherever it survives — which is also why a `remove` entry may keep an `attachmentRecordId` naming an `_attachment` record that has since been destroyed. What the erasure primitive destroys is the purged record's own content, history and log; it does not reach into what other records say.

## Reading it

- `stack.getJournal(recordId, { sinceSeq?, limit? })` — the log, oldest first.

**A record that does not exist is `StackNotFoundError`, never an empty log.** A purged record is gone, so it is the same refusal. An empty log means "nothing changed" unconditionally — that is the whole argument for the mandatory endpoint below — and it cannot also mean "no such record" without taking the one reading a caller reconstructing an association's history depends on.

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
