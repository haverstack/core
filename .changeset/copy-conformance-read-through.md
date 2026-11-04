---
'@haverstack/adapter-conformance': minor
---

`runCopyConformance()` takes `readThrough`, the adapter a copy reads its source store through, such as a server's store read over the wire by `APIAdapter`. The copy is still held to what the store itself holds, and `close` is called on the adapter `readThrough` opens too.
