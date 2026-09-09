---
'@haverstack/record-adapter-sqlite': minor
'@haverstack/record-adapter-do-sqlite': minor
---

Rework the shared SQLite storage layout so reads are index-driven,
trading index bytes for read latency and write throughput.

`content_sort` and `file_refs` held one row per top-level content field
each, on the same key and with the same lifecycle; they are now one
`content_index`, halving the per-write index maintenance and removing a
table and its implicit index from the file. A `value_rank` column
replaces the "is num_value null" partitioning, so a single index carries
the whole content ordering where two carried none the planner would use.

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
was written on every record write and never read. A foreign reader can no
longer rank against `records_fts` with `bm25()`.

Measured over 20k records: listings and content sorts 5-7x faster, writes
~19% faster, table bytes ~7% smaller, index bytes ~7% larger, and the
file ~2% larger overall. Carrying the sort key on the filter indexes is
what costs those bytes, and what makes a filter on a low-cardinality
column — one entity, a handful of types, most records without a parent —
an ordered index walk rather than a sort of everything it matched.

Query results, ordering and cursors are unchanged. The stack file layout is
not — an existing database is not readable by this version.
