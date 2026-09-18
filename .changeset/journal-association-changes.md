---
'@haverstack/core': minor
'@haverstack/wire-types': minor
'@haverstack/adapter-api': minor
'@haverstack/adapter-conformance': minor
'@haverstack/conformance-fixtures': minor
'@haverstack/record-adapter-sqlite': minor
---

Give the change journal its own association shape, and write down the erasure boundary around a purge.

A journal entry's three association lists become one tagged list, `associations: AssociationChange[]`, with `add`, `repoint` and `remove` arms. Each element carries the state it displaced, so an inverse is read off one element instead of joined across two lists against a key that was never identity. A removal now keeps the annotation it carried, which makes it as undoable as a re-point. The change feed keeps its two flat lists unchanged; they are flattened out of the entry's list, so the two halves cannot disagree. The `journal` table replaces its three `associations_*` columns with one, and `GET /records/:id/journal` carries the new field.

An association list holding one identity twice is now refused with `StackValidationError` rather than collapsed, and every adapter keys associations by identity.

`delete()` returns `{ referencedFileIds }`: a purge deletes no bytes, but it destroys the only rows naming the files the record referenced, so it reports them and the caller makes the intentional `deleteAttachment()` call. A hard delete over the wire answers `200` with the record it destroyed rather than `204`, which is where a client reads that report.

`getJournal()` throws `StackNotFoundError` for a record that does not exist or was purged, instead of answering an empty log — an empty log means "nothing changed" unconditionally.
