---
'@haverstack/core': minor
'@haverstack/wire-types': minor
'@haverstack/conformance-fixtures': minor
'@haverstack/adapter-api': minor
'@haverstack/adapter-local': minor
'@haverstack/record-adapter-sqlite': minor
'@haverstack/record-adapter-do-sqlite': minor
---

A stack has no timezone. `_config` holds only `{ ownerEntityId }`: a time value carries what it means, so reading one never depends on the stack (see docs/spec/data-model.md § Types).

- `timezone` is removed from `ConfigContent` and the `_config@1` schema, from every adapter's `open()` options, from `stack.timezone` and `StackRecordAdapter` and every adapter that exposed it, and from the discovery response (`DiscoveryResponse` and the discovery fixtures; `discovery-omits-absent-timezone` is removed).
- `StackIdentity` is `{ ownerEntityId }`, and `newStoreSeed()` takes the first `_config`'s content, `ConfigContent`.
