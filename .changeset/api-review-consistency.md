---
'@haverstack/core': minor
'@haverstack/wire-types': minor
'@haverstack/adapter-api': minor
'@haverstack/adapter-local': minor
'@haverstack/record-adapter-sqlite': minor
'@haverstack/record-adapter-do-sqlite': minor
---

Final consistency pass over the public API.

- `collectAttachmentGarbage()` reports `deletedFileIds: FileId[]`, matching `DeleteResult.referencedFileIds`, instead of `deleted: string[]`.
- `RecordChange.associationsAdded`/`associationsRemoved` (and their wire counterparts) are typed `DataAssociation[]`, matching what the feed has always carried: permission moves are announced by the `reshare` op, never in these lists.
- `CreateRecordOptions.id`/`parentId` and `RecordChangeSet.parentId` are typed `RecordId`.
- The stack owner is named `ownerEntityId` wherever an adapter is created, matching the `ownerEntityId` it then exposes: `LocalAdapter.initialize()`/`openOrInitialize()`, `NativeSQLiteRecordAdapter.initialize()` and `DoSQLiteRecordAdapter.openOrInitialize()` take `ownerEntityId` instead of `entityId`, and `APIAdapter.open()` takes `expectedOwnerEntityId` instead of `expectedOwner`.
- `DoSQLiteRecordAdapter.create()` is `openOrInitialize()`, the name `LocalAdapter` uses for the same reattach-or-create behavior.
- Adapter option types are named `<Class><Method>Options`: `LocalAdapterInitializeOptions`, `LocalAdapterOpenOptions`, `LocalAdapterOpenOrInitializeOptions`, `NativeSQLiteRecordAdapterInitializeOptions`, `NativeSQLiteRecordAdapterOpenOptions`, `DoSQLiteRecordAdapterOpenOrInitializeOptions` and `NativeTokenStoreOpenOptions`.
