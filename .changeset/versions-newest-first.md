---
'@haverstack/core': minor
'@haverstack/adapter-conformance': minor
---

`MemoryAdapter.getVersions()` returns versions newest first, matching the SQLite adapters and `APIAdapter`. The order is now stated in the spec and `StackRecordAdapter`, and pinned by an `adapter-conformance` test.
