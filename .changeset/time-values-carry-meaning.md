---
'@haverstack/core': minor
'@haverstack/wire-types': minor
'@haverstack/conformance-fixtures': minor
'@haverstack/adapter-api': minor
'@haverstack/adapter-local': minor
'@haverstack/record-adapter-sqlite': minor
'@haverstack/record-adapter-do-sqlite': minor
'@haverstack/adapter-conformance': patch
---

A time value carries what it means: a `date`'s form says whether it is a moment, a calendar day or a wall-clock reading (see docs/spec/data-model.md § Types). Nothing reads a stack-wide timezone, so `_config` holds only `{ ownerEntityId }`.

- `timezone` is removed from `ConfigContent` and the `_config@1` schema, from every adapter's `open()` options, from `stack.timezone` and `StackRecordAdapter` and every adapter that exposed it, and from the discovery response (`DiscoveryResponse` and the discovery fixtures; `discovery-omits-absent-timezone` is removed).
- `StackIdentity` and `identityOf()` are removed: `ConfigContent` is what an adapter holds, and `newStoreSeed()` stores the one it is given whole.
