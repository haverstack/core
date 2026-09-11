---
'@haverstack/sqlite-shared': patch
'@haverstack/record-adapter-sqlite': patch
'@haverstack/record-adapter-do-sqlite': patch
---

Collapse the duplicated shapes in `@haverstack/sqlite-shared`. `index.ts`
now re-exports `record.ts` and adds only the token-store and file-lock
pieces, rather than restating the whole surface — the two barrels had
already drifted, with `isUniqueConstraintViolation` exported from the
record-only one and missing from the full one. In `record-logic.ts` the
version-guarded `UPDATE`, the post-commit re-read, the
replace-a-record's-associations write, the `versions` column list and the
optimistic-concurrency error each live in one place now. `query.ts` builds
its `IN`, date-range and association semi-join predicates from one helper
apiece.

Two behavior changes fall out of the deduplication. `restoreVersion()` and
`commitMigration()` now carry `expectedVersion` into their `UPDATE`'s
`WHERE` clause, as every other mutation already did, so a writer that
slips in between the precondition check and the write is caught rather
than overwritten. A soft `deleteRecord()` stamps `deleted_at` and
`updated_at` from a single timestamp, which can no longer straddle a
millisecond boundary and leave the two columns disagreeing about when the
delete happened.
