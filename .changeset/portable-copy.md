---
'@haverstack/core': minor
'@haverstack/record-adapter-sqlite': minor
'@haverstack/record-adapter-do-sqlite': minor
'@haverstack/adapter-local': minor
'@haverstack/adapter-api': minor
'@haverstack/adapter-conformance': minor
---

A stack can be copied whole between adapters, authorship and history included.

- `copyStack(from, to)` in `@haverstack/core/adapter` carries every Record, soft-deleted and unlisted ones too, with its versions and journal, plus every Type and the bytes its attachment records name. Copying into a `LocalAdapter` store is an export; copying out of one is an import.
- It writes through the new optional `StackRecordAdapter.importRecord(record, { versions, journal })`, which every local adapter implements and `APIAdapter` does not.
- `saveVersion()` is removed from the adapter contract: `importRecord()` is the one standalone history write.
- `@haverstack/adapter-conformance` checks `importRecord()` in the record suite and adds `runCopyConformance()`, a round trip through a full adapter.
