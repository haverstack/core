---
'@haverstack/core': minor
---

Tighten the public surface. `ScopedStack` can no longer be constructed directly — `Stack.asEntity()`/`asActor()` are the only way to obtain one — and it now exposes read-only `principalId` and `subjectId`. `Stack.assertOpen()` and `Stack.relaysChanges` are private. The root export drops the adapter-only types `ExpectedVersionOptions`, `SnapshotOptions`, `BumpVersionOptions`, `JournalEntryInput`, `JournalOptions`, `ContentFilterReach` and `MissingCapability` (import them from `@haverstack/core/adapter`), removes the `PermissionGrantee` alias (use `Grantee`), and adds `DefineTypeOptions` and `AppId`. `StackClient` types ID parameters as `RecordId`/`FileId`, and `StackRecordAdapter.subscribeChanges` resolves to `Unsubscribe`.
