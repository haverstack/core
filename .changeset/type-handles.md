---
'@haverstack/core': minor
---

Add `typeHandle()` and the derived `ContentOf` and `PatchOf` types, with typed overloads of `get`, `query`, `create`, `mutate`, `patchContent` and `subscribe` on `Stack` and `ScopedStack` that take a handle. A typed read checks the record is the handle's Type and refuses an unlisted enum value or a tombstone. `defineType()` accepts a handle's `id` and `schema`.
