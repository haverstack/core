---
'@haverstack/record-adapter-sqlite': patch
'@haverstack/record-adapter-do-sqlite': patch
---

Concurrent writes to one record no longer lose updates: `mutateRecord`, `restoreVersion` and `commitMigration` read and check the record inside the transaction that writes it, so a content patch applies to the content as it stands rather than to an earlier read.
