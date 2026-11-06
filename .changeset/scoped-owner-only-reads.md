---
'@haverstack/core': minor
---

`ScopedStack` now decides every request a session makes, so a server built on it makes no ownership or permission determination of its own. It gains `defineType()`, `listBlobs()` and `head()` (the owner acting alone only), `getType()` and `listTypes()` (open to every requester), and `planInstall(manifest)`, which plans for the session's own key and refuses anonymous and delegated sessions. `Stack` gains `listBlobs()` and `head()`, present exactly when its adapter has them. `StackClient` is unchanged.

`createOptionsFromWireRecord(body, scoped)` takes the `ScopedStack` the server will create through, in place of a session and the owner's id, and `isOwnerActingAlone()` is no longer exported from `@haverstack/core/wire`.

`MemoryAdapter.head` in `@haverstack/core/testing` is now an optional field, as `listBlobs` is, so a test subclass can remove it; a caller invoking it directly asserts it present (`adapter.head!()`).
