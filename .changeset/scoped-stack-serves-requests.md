---
'@haverstack/core': minor
'@haverstack/adapter-api': minor
---

`StackClient` is now everything a session can ask of a stack, and `ScopedStack` decides each one, so a server built on it makes no ownership or permission determination of its own. `StackClient` gains `defineType()`, `getType()`, `listTypes()`, `typeIsCompatible()`, and the optional `listBlobs()` and `head()`, which `Stack` has exactly when its adapter does and `ScopedStack` exactly when its `Stack` does. `ScopedStack` refuses `defineType()`, `listBlobs()` and `head()` to all but the owner acting alone.

`ScopedStack.answerInstall(manifest)` answers an install request for the session's own key, `installed` or `pending`, refusing anonymous and delegated sessions.

`createOptionsFromWireRecord(body, scoped)` takes the `ScopedStack` the server will create through, in place of a session and the owner's id, and reads its new `ownerActingAlone`. `isOwnerActingAlone()` is removed.

`InstallRequestResult` is exported from `@haverstack/core` instead of `@haverstack/adapter-api`.

`MemoryAdapter.head` in `@haverstack/core/testing` is now an optional field, as `listBlobs` is, so a test subclass can remove it; a caller invoking it directly asserts it present (`adapter.head!()`).
