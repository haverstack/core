---
'@haverstack/core': minor
'@haverstack/sqlite-shared': minor
'@haverstack/record-adapter-sqlite': minor
'@haverstack/record-adapter-do-sqlite': minor
'@haverstack/adapter-api': minor
'@haverstack/conformance-fixtures': minor
---

Sort by a top-level content field: `query({ sort: { contentField: 'publishedAt', direction: 'desc' } })`. A consumer wanting a bounded page in a meaningful order previously had to page the whole matched set and sort it in memory — a cost that grew with the stack while the page stayed the same size.

`QuerySort` gains a `contentField` member beside `field` rather than widening `field` to a string: a content field may be named `version`, and a `'content.'` prefix collides with the filter path separator. Over the wire the two are `?sortContent=` and `?sort=`, and a request naming both is refused.

The ordering is defined once in core so no two adapters answer one query differently. A field orders as the kind its schema declares — dates as instants, booleans as false-then-true — a record holding no value at the field sorts last in both directions, numbers precede text where types disagree about a field name, and text orders by a case- and accent-folded key (`apple`, `Émile`, `Zebra`) rather than by code point. What that fold does not promise — locale tailoring, script-aware or natural-number ordering — is stated in `docs/spec/data-model.md` § Text ordering.

SQLite-backed adapters materialize a `content_sort` index, maintained on every write alongside `file_refs`, and only for top-level scalars — the same line `file-ref` indexing draws.

`AdapterCapabilities` gains `contentFieldSort`, and `sortableFields` is now enforced rather than merely declared: a sort an adapter has not declared throws `StackQueryError` instead of being answered in some other order. `sortableFields` is typed `NativeSortField[]`, since content fields are unbounded and an adapter that indexes content for sorting indexes every top-level scalar.

`MemoryAdapter` now honors `sort`, where it previously returned insertion order whatever the query asked for.
