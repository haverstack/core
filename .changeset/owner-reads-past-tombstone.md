---
'@haverstack/core': minor
'@haverstack/conformance-fixtures': minor
---

The owner acting alone reads a soft-deleted Record whole under `ScopedStack`, on every channel: `get()`, `query()`, a soft delete's answer and the change feed. They hold the unscoped `Stack`'s standing, which projects nothing, so a hosted stack read over the wire is read as it is stored. Everyone else, a delegated owner included, still reads the tombstone. Deletion stays visible: a soft-deleted Record is excluded until a read passes `includeDeleted`, and carries `deletedAt` when it does.

- A copy out of a hosted stack carries soft-deleted Records whole, and `Stack` over `APIAdapter` opened as the owner reads them as it does over a local adapter. Collection there no longer misses what a soft-deleted Record references.
- `getEntityByDid()` finds a soft-deleted card for every reader who may read it, as `identity.md` says it should: the tombstone to anyone else, the card whole to the owner acting alone. `ScopedStack` matches the card as stored, then gates and presents it as `get()` does; it matched after presenting, against a tombstone's emptied `did`, and so found none.
- Fixtures: `delete-record-soft` and the change feed's delete mutation are answered whole to the owner; `get-record-after-soft-delete` names a non-owner requester and keeps the tombstone; `get-record-after-soft-delete-owner` is new.
