---
'@haverstack/core': minor
'@haverstack/conformance-fixtures': minor
'@haverstack/adapter-conformance': minor
'@haverstack/record-adapter-sqlite': minor
---

Rename the change kind `deleted` to `removed`. It names what a subscriber does with its copy, and covers both a soft delete and an unlist; `ops` still says which. The set stays `created`, `changed`, `removed`, `purged`, and the `?kind=` filter and journal `kind` column take the new value.
