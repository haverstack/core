---
'@haverstack/core': minor
'@haverstack/wire-types': minor
'@haverstack/adapter-api': minor
'@haverstack/conformance-fixtures': minor
---

Serve the change journal over the wire

`GET /records/:id/journal` reads a record's change journal, so
`getJournal()` answers over `adapter-api` instead of refusing. It was the
one required `StackClient` method the adapter fronting a server could never
answer, which made "required" mean "required except where it matters" — and
it left the argument that took associations out of version history only
half true. Associations were dropped from snapshots because the journal
keeps what an inverse cannot reconstruct; over the wire that store was
unreachable, so an `attachmentRecordId` a re-point discarded was gone for
good. `associationsReplaced` is now readable wherever a stack lives.

`APIAdapterCapabilityError` accordingly drops `'journal'` from its
`capability` union, and refuses nothing for this surface any more.

**The endpoint is mandatory, not advertised in discovery.** A server with
no journal has only one spelling available to it — an empty log — and that
is the answer it must not give, since a caller reconstructing an
association's history cannot tell it from "nothing changed". A feed can be
advertised because a client can be told up front it will not get a live
connection; a log is a question with a wrong answer.

**Responses are paged, and the local contract is not.** `{ entries, cursor }`
mirrors a query envelope: a server MAY answer a page shorter than the
`limit` asked for — this is the one read with no ceiling when `limit` is
omitted, so it needs that freedom — and `cursor` is the only end-of-log
signal. `APIAdapter.getJournal()` follows it to the end, so "omitting
`limit` reads the whole log" holds identically whatever page size a server
picks and no caller has to know which adapter it is on.

**`previousParentId` is the one field on any response where `null` is a
value rather than an input spelling.** Absent means the entry is not a
reparent; present and `null` means the record moved out of the root.
Everywhere else — a record body, a snapshot — both collapse to absent,
which here would lose which of the two happened.

New: `WireJournalEntry`, `WireJournalResponse` and `serializeJournalEntry()`
from `@haverstack/wire-types`, `parseJournalParams()` from
`@haverstack/core/wire` so a server decodes the window with the grammar the
client builds it with, and four `getJournalFixtures` plus a `403` case
pinning the mutate-surface gate. `serializeChangeActor()` is now shared by
a change frame and a journal entry rather than inlined in one of them.

The journal stays per-record: `seq` is dense from 1 per record, so this
endpoint reads the history of a record you can already name and does not
answer "which records changed while I was disconnected". A reconnect still
reconciles that by query, as it did before.
