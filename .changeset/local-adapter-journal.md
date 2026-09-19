---
'@haverstack/adapter-local': patch
---

Carry a write's journal entry through `LocalAdapter`

`createRecord()`, `associate()` and `dissociate()` took the options object
the record adapter beneath them expects and dropped it on the way through,
so `opts.journal` never reached storage. Every other mutating method
forwarded it.

A stack on this adapter therefore recorded no journal entry for a create or
for either association verb — the two the tier exists for. `getJournal()`
answered an empty log, which means _nothing changed_ unconditionally, so a
caller reconstructing an association's history was told there was none
rather than being refused. An `attachmentRecordId` a re-point overwrote was
retained nowhere, which is the one thing no other tier keeps.
