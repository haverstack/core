---
'@haverstack/core': minor
---

Typed access goes through collections. `client.collection(handle)` returns a `Collection` typed by the handle's content, with one signature per verb — `get`, `query`, `subscribe`, `create`, `mutate`, `patchContent`, `associate`, `dissociate`, `amendAssociations`, `grantAccess`, `revokeAccess`, `amendAccess`, `delete`, `undelete` and `restoreVersion` — every one returning a typed record without a re-read. A collection spans the handle's whole family and migrates each record in memory to the handle's version. A record stored at a newer version is a misfit: `query()` reports it in `misfits` and keeps the page and cursor, `get()` throws `MisfitError`, and `subscribe()` carries it as `misfit`. A content write to a record at an older version commits its migration as a write of its own first. `collection()` refuses a handle whose `migratesFrom` has no migration passed to `Stack.open()`.

The handle-first overloads of `get`, `query`, `create`, `mutate`, `patchContent` and `subscribe` are removed, with `TypedRecord`, `TypedQuery`, `TypedChange`, `TypedChangeSet` and `TypedSubscribeOptions`.
