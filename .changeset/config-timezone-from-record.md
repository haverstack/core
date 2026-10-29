---
'@haverstack/core': minor
'@haverstack/wire-types': minor
'@haverstack/conformance-fixtures': minor
'@haverstack/adapter-api': minor
'@haverstack/adapter-local': minor
'@haverstack/record-adapter-sqlite': minor
'@haverstack/record-adapter-do-sqlite': minor
---

A stack's `timezone` is read from `_config` like any Record field: `(await stack.get('_config'))?.content.timezone`. Adapters cache only the immutable `ownerEntityId`, so no cached copy can disagree with a patched `_config`.

- `stack.timezone` and `timezone` on `StackRecordAdapter` and every adapter (`MemoryAdapter`, `combineAdapters()`, `LocalAdapter`, `NativeSQLiteRecordAdapter`, `DoSQLiteRecordAdapter`, `APIAdapter`) are removed. `StackIdentity` is `{ ownerEntityId }`.
- `timezone` stays a creation input to `open()`. `newStoreSeed()` takes the first `_config`'s content, `ConfigContent`.
- The discovery response (`GET /.well-known/stack`) no longer carries `timezone`, in `DiscoveryResponse` and the discovery fixtures; `discovery-omits-absent-timezone` is removed.
