---
'@haverstack/record-adapter-sqlite': minor
'@haverstack/record-adapter-do-sqlite': minor
---

Move the engine-independent half of the SQLite record adapters into `@haverstack/sqlite-shared`

`SharedSqlRecordAdapter` is a new abstract base implementing all seventeen `StackRecordAdapter` methods as forwards to `SharedSqlRecordLogic`, alongside `SQLITE_RECORD_CAPABILITIES` — the capability declaration every engine running the shared query builder makes. Both adapters now supply only what differs between bindings: the database handle, the schema call, and their own `flush`/`close`. `applyRecordSchema()` and `tryReadStackConfig()` replace the per-adapter pragma sequences and the hand-written `_config` lookup.

`ownerEntityId` and `timezone` are now `readonly` on both adapter classes, matching how `StackRecordAdapter` has always declared them.

Declaration output now inlines the shared package's types instead of importing them. `@haverstack/record-adapter-do-sqlite`'s `.d.ts` previously named `@haverstack/sqlite-shared/record`, which is private and never installed, so its types did not resolve for consumers.
