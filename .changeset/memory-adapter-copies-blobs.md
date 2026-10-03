---
'@haverstack/core': patch
---

`MemoryAdapter` copies blob bytes in `putBlob()` and `getBlob()`, so callers can no longer change stored blobs through a shared array.
