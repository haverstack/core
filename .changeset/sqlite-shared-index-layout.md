---
'@haverstack/record-adapter-sqlite': minor
'@haverstack/record-adapter-do-sqlite': minor
---

Rework the shared SQLite storage layout so reads are index-driven and the
on-disk footprint drops.

`content_sort` and `file_refs` held one row per top-level content field
each, on the same key and with the same lifecycle; they are now one
`content_index` table, halving the per-write index maintenance and
removing a table and its implicit index from the file. A `value_rank`
column replaces the "is num_value null" partitioning, so a single index
carries the whole content ordering.

A content-field sort now reads as two ordered index walks — the records
holding a value at the field, then the records holding none — instead of
a LEFT JOIN the planner could only sort after the fact. Filter indexes on
`records` carry `(created_at, id)` so a filtered listing walks the index
in order and stops at the page boundary; the `deleted_at` and
`unlisted_at` indexes are gone, since every query asks for `IS NULL` and
their presence steered the planner away from the ordering index. The
redundant `idx_assoc_record_id` and `idx_tokens_hash` are gone too — the
primary key and the UNIQUE constraint already index those columns.

`records_fts` is declared `columnsize=0`: search here is a membership
test, never a relevance ranking, so the per-row token-count shadow table
was written on every record write and never read.

Query results, ordering, totals and cursors are unchanged. The stack file
layout is not — an existing database is not readable by this version.
