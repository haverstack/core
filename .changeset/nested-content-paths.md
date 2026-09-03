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

This replaces the reading in which a filter key named one top-level field
literally: `{ content: { 'a.b': 1 } }` now asks for `b` inside `a` on every
adapter, and a field literally named `a.b` is no longer writable. Paths and
field names are kept unambiguous from the write side rather than by an escape
convention: a content field name may no longer contain `.`, `[`, `]`, `$`,
`"`, `*`, or `#`, at every depth and in a declared schema alike, with
`StackValidationError`. An escape convention fails silently when app code
builds a key from a variable name; a write-time rule fails loudly while the
caller can still pick another name. The guarantee that no key is reinterpreted
as syntax is kept: a segment is carried as a bound parameter matched against a
key, never assembled into a path expression, and a key that cannot be a path
is `StackQueryError` (400) rather than an engine error.

Multi-segment keys are gated on a new `nestedContentQuery` capability rather
than on a widened `contentFieldQuery`: a foreign server declaring the latter
matches whole field names, and reading that as a promise of traversal would
hand a client an unfiltered superset presented as a filtered result. A
discovery response omitting the flag means `false`.

A `null` filter value now reads as "no value at the path, or a value that is
null", so a missing intermediate matches. A path is capped at 32 segments,
the longest both SQLite engines can execute. Nested fields stay unindexed, and
depth multiplies cost: each segment fans out across every element of an array
it meets, so a server owes the bound in wire-format's Bounding query cost.
A `file-ref` nested in an array or object is now reachable by a filter but is
still not indexed as a reference.
