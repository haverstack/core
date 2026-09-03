---
'@haverstack/record-adapter-sqlite': patch
---

Reclaim a lock file that is not parseable JSON rather than failing to open the database. A lock file is written non-atomically, so a crash mid-write left a torn one that no error message offered a way past. The in-use error now also names the lock file to remove.
