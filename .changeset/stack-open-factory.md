---
'@haverstack/core': minor
---

Rename the static factory `Stack.create(adapter, opts)` to `Stack.open(adapter, opts)`, so it no longer shares a name with the record-creating `stack.create(typeId, content)`. An adapter with no `ownerEntityId` now throws the exported `InvalidAdapterError` (outside the `StackError` root) instead of a plain `Error`.
