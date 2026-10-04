---
'@haverstack/core': minor
---

Content fields are never `null`: `create()` and `commitMigration()` drop top-level fields set to `null` or `undefined` (and the same inside declared nested objects, not `open` ones) before storing, and `create()` returns the stored content. `MemoryAdapter` no longer keeps `undefined`-valued keys.
