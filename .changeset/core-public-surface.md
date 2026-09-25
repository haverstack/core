---
'@haverstack/core': minor
---

Tighten the public surface. `ScopedStack` can no longer be constructed directly — `Stack.asEntity()`/`asActor()` are the only way to obtain one — and it now exposes read-only `principalId` and `subjectId`. `Stack.assertOpen()` and `Stack.relaysChanges` are private. The adapter-only types `SnapshotOptions`, `BumpVersionOptions`, `JournalEntryInput` and `JournalOptions` move from the root to `@haverstack/core/adapter`, and the root adds `DefineTypeOptions` and `AppId`. `StackClient` types ID parameters as `RecordId`/`FileId`, and `StackRecordAdapter.subscribeChanges` resolves to `Unsubscribe`.
