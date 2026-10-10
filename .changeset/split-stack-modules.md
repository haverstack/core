---
'@haverstack/core': patch
---

Split `Stack` and `ScopedStack` into folders of smaller modules: the `StackClient` interface and its option types, the migration registry, the system Type definitions and the scoped change feed each live in a file of their own. The public API is unchanged.
