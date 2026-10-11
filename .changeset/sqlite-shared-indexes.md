---
'@haverstack/record-adapter-sqlite': patch
'@haverstack/record-adapter-do-sqlite': patch
---

Internal restructure of the bundled SQLite record logic: the full-text and content indexes move into their own module. No behavior change.
