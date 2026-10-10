---
'@haverstack/core': minor
'@haverstack/adapter-api': patch
'@haverstack/adapter-local': patch
'@haverstack/record-adapter-sqlite': patch
---

`StackRecordAdapter.subscribeChanges()` takes `SubscribeOptions`, the same options a subscriber passes to `subscribe()`. `SubscribeChangesOptions` is gone from `@haverstack/core/adapter`; it had the same fields, and `Stack` already forwarded every one of them, the subscriber's own `onError` included. A new `MutateOptions` type in `@haverstack/core/adapter` names the options every version-bumping adapter mutation takes. `GrantContent` and `InstallRequest` are now derived from `TypeGrant`.
