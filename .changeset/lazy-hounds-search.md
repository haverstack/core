---
'@haverstack/record-adapter-sqlite': patch
---

Association query filters read through their indexes

`tags`, `hasAttachment`, `attachmentFileId` and `relatedTo` were correlated
`EXISTS` subqueries, which make SQLite scan every record and probe the association
primary key for each. Phrased as semi-joins, the planner drives from the association
side instead — reading the matching rows through `idx_assoc_kind_label`,
`idx_assoc_kind_file_id`, `idx_file_refs_file_id` or `idx_assoc_related`, then looking
up those records. The cost of an association filter becomes proportional to how many
records match it rather than to how many the stack holds, so the gain grows with
selectivity: the more precisely you ask, the more you save.

Measured on 20k records with 4k associations, none of the four now needs a full table
scan. `attachmentFileId` benefits most, at 8.8ms to 0.14ms, because SQLite resolves
its two-sided condition as a multi-index OR across both indexes rather than scanning
once and probing twice.

Results are unchanged; this is the same set of records, found a different way.
