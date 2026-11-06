---
'@haverstack/core': minor
'@haverstack/adapter-api': minor
---

`StackClient` is now everything a session can ask of a stack, and `ScopedStack` decides each one, so a server built on it makes no ownership or permission determination of its own. It gains `defineType()`, `getType()`, `listTypes()` and `typeIsCompatible()`, and the optional `listBlobs()`, `head()` and `requestInstall()`, each present wherever it can be answered: on `Stack` exactly when its adapter has it. `ScopedStack` refuses `defineType()`, `listBlobs()` and `head()` to all but the owner acting alone, and `requestInstall()` to anonymous and delegated sessions, answering it from `planInstall()` for the session's own key. `StackRecordAdapter` gains the optional `requestInstall()`, which `combineAdapters()` forwards.

`createOptionsFromWireRecord(body, scoped)` takes the `ScopedStack` the server will create through, in place of a session and the owner's id, reading its new `ownerActingAlone`; `isOwnerActingAlone()` is no longer exported from `@haverstack/core/wire`.

`InstallRequestResult` is exported from `@haverstack/core` instead of `@haverstack/adapter-api`.

`MemoryAdapter.head` in `@haverstack/core/testing` is now an optional field, as `listBlobs` is, so a test subclass can remove it; a caller invoking it directly asserts it present (`adapter.head!()`).
