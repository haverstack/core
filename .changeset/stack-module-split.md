---
'@haverstack/core': patch
---

Split `stack.ts` into focused modules. The `Stack` and `ScopedStack`
classes, the error taxonomy, the query sanitizers, grant coverage, DID
bindings, record-id validation and the change-set helpers now live in
their own files. Exported names and their types are unchanged — nothing a
consumer can observe.
