---
'@haverstack/conformance-fixtures': minor
---

Replace `getVersionsAfterMutateFixtures` with `getVersionsSequenceFixtures`: one sequence that reads the version history before and after a restore, a migration and an association, so the order those reads depend on is part of the data. The history now includes the version 2 snapshot a record at version 3 holds.
