---
'@haverstack/core': minor
'@haverstack/record-adapter-sqlite': minor
'@haverstack/record-adapter-do-sqlite': minor
'@haverstack/adapter-api': minor
'@haverstack/conformance-fixtures': minor
---

Make nested content queryable: a `filter.content` key is now a dot-separated
path, and an array anywhere along it is matched element-wise. `contact@1`
stores `emails` as `[{ value, label }]`, so "which contact has this address"
is `{ content: { 'emails.value': 'ada@example.com' } }` rather than a fetch
and an in-memory scan. Containment falls out of the same rule, so
`{ content: { tags: 'starred' } }` matches a record whose `tags` array
contains it.

Paths and field names are kept unambiguous from the write side rather than by
an escape convention: a content field name may no longer contain `.`, `[`,
`]`, `$`, `"`, `*`, or `#`, at every depth and in a declared schema alike,
with `StackValidationError`. An escape convention fails silently when app code
builds a key from a variable name; a write-time rule fails loudly while the
caller can still pick another name.

Multi-segment keys are gated on a new `nestedContentQuery` capability rather
than on a widened `contentFieldQuery`: a foreign server declaring the latter
matches whole field names, and reading that as a promise of traversal would
hand a client an unfiltered superset presented as a filtered result. A
discovery response omitting the flag means `false`.

A `null` filter value now reads as "no value at the path, or a value that is
null", so a missing intermediate matches. Nested fields stay unindexed — a
path filter is an unindexed walk in the same cost bucket as full-text search.
A `file-ref` nested in an array or object is now reachable by a filter but is
still not indexed as a reference.
