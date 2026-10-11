---
'@haverstack/record-adapter-sqlite': patch
'@haverstack/record-adapter-do-sqlite': patch
---

Remove redundant code from the bundled SQLite record logic: unused barrel exports, local aliases of core's native sort fields, and repeated not-found/version-read/row-hydration code.
