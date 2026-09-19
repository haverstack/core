---
'@haverstack/core': minor
---

Drop a `permissions` key the reshare gate read as inert

`ScopedStack.mutate()` decides whether a change set's `permissions` key moves
the ACL against the record it read for the gate; `Stack.mutate()` recomputes
that delta against its own read and writes the key only where its delta is
non-empty. Those are two reads, so a key forwarded on the strength of the
first could replace the ACL on the strength of the second — a requester
holding the write bit but no reshare authority could restate the set beside a
content patch and silently withdraw an element granted in between.

The key is now dropped rather than forwarded once the gate has established it
moves nothing, so what reaches the write is only ever what the gate
authorized. A requester who may reshare keeps the key's ordinary replacing
semantics, concurrency included.
