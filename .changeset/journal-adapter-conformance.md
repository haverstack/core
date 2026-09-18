---
'@haverstack/adapter-conformance': minor
---

Cover the change journal in the record adapter suite

`getJournal()` is required of every adapter — an empty log has to mean "nothing
changed" unconditionally, because the alternative spelling available to an
adapter with no journal is exactly that answer. The suite that calls itself the
runnable form of the adapter contract checked version snapshots and associations
and said nothing about the tier beside them, so an adapter could pass every test
here while returning `[]` from `getJournal()` forever.

Nine tests close that: the method's presence, `seq` dense from 1 and counted per
record, the `version`/`typeId`/`parentId` stamp coming off the row the write
produced rather than the caller, a version that stands still across an
association change, `associationsReplaced` surviving the round trip,
`previousParentId` telling "did not move" apart from "moved off the root", the
`sinceSeq`/`limit` window, a failed mutation leaving no entry, and a hard delete
destroying the log rather than leaving it for the next record at that id.
