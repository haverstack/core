---
'@haverstack/core': minor
'@haverstack/record-adapter-sqlite': minor
'@haverstack/record-adapter-do-sqlite': minor
'@haverstack/adapter-local': minor
'@haverstack/adapter-api': minor
'@haverstack/adapter-conformance': minor
---

A stack can be copied whole between adapters, authorship and history included.

- `copyStack(from, create)` in `@haverstack/core/adapter` copies every Record, soft-deleted and unlisted ones too, with its versions and journal, plus every Type and every blob, into a new store `create` makes with the source's identity, and returns it open. Copying into a `LocalAdapter` store is an export; copying out of one is an import.
- It writes through the new optional `StackRecordAdapter.importRecord(record, { versions, journal })`, which every local adapter implements and `APIAdapter` does not.
- `StackIdentity` and `CreateStore` are exported beside it.
- `saveVersion()` is removed from the adapter contract: `importRecord()` is the one standalone history write.
- `@haverstack/adapter-conformance` checks `importRecord()` in the record suite and adds `runCopyConformance()`, which holds a full adapter to both halves of a copy.
