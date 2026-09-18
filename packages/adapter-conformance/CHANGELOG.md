# @haverstack/adapter-conformance

## 0.3.0

### Minor Changes

- [#296](https://github.com/haverstack/core/pull/296) [`5feb1cd`](https://github.com/haverstack/core/commit/5feb1cd1a58726df6e9ff113daab57c27935d843) Thanks [@cuibonobo](https://github.com/cuibonobo)! - Give the change journal its own association shape, and write down the erasure boundary around a purge.

  A journal entry's three association lists become one tagged list, `associations: AssociationChange[]`, with `add`, `repoint` and `remove` arms. Each element carries the state it displaced, so an inverse is read off one element instead of joined across two lists against a key that was never identity. A removal now keeps the annotation it carried, which makes it as undoable as a re-point. The change feed keeps its two flat lists unchanged; they are flattened out of the entry's list, so the two halves cannot disagree. The `journal` table replaces its three `associations_*` columns with one, and `GET /records/:id/journal` carries the new field.

  An association list holding one identity twice is now refused with `StackValidationError` rather than collapsed, and every adapter keys associations by identity.

  `delete()` returns `{ referencedFileIds }`: a purge deletes no bytes, but it destroys the only rows naming the files the record referenced, so it reports them and the caller makes the intentional `deleteAttachment()` call. A hard delete over the wire answers `200` with the record it destroyed rather than `204`, which is where a client reads that report.

  `getJournal()` throws `StackNotFoundError` for a record that does not exist or was purged, instead of answering an empty log — an empty log means "nothing changed" unconditionally.

### Patch Changes

- Updated dependencies [[`5feb1cd`](https://github.com/haverstack/core/commit/5feb1cd1a58726df6e9ff113daab57c27935d843)]:
  - @haverstack/core@0.34.0

## 0.2.0

### Minor Changes

- [#294](https://github.com/haverstack/core/pull/294) [`d9a088a`](https://github.com/haverstack/core/commit/d9a088ac710bfc4cb2310e9a38914dc28f70b325) Thanks [@cuibonobo](https://github.com/cuibonobo)! - Cover the change journal in the record adapter suite

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
