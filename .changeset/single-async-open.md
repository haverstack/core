---
'@haverstack/core': minor
'@haverstack/record-adapter-sqlite': minor
'@haverstack/adapter-local': minor
'@haverstack/record-adapter-do-sqlite': minor
'@haverstack/adapter-api': minor
---

Open every identity-holding adapter with a single async `open()`. `NativeSQLiteRecordAdapter` and `LocalAdapter` replace `initialize()`/`open()`/`openOrInitialize()` with `open({ path, create?, ownerEntityId?, … })`, where `create` is `'never'` (default), `'ifMissing'` or `'exclusive'`. `DoSQLiteRecordAdapter.openOrInitialize()` is now `open()`. `APIAdapter`'s `expectedOwnerEntityId` option is renamed `ownerEntityId`. A plain-string `ownerEntityId` is checked against an existing store on every adapter, and a mismatch throws the new `OwnerMismatchError` from `@haverstack/core/adapter`, replacing `LocalAdapterOwnerMismatchError` and `APIAdapterOwnerMismatchError`. `MemoryAdapter` and `IncapableMemoryAdapter` (`@haverstack/core/testing`) are opened with `await X.open({ ownerEntityId })`; `ownerEntityId` is required.
