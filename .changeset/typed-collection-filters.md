---
'@haverstack/core': minor
---

A collection's `filter.content`, `filter.contentPresent` and `sort.contentField` are typed from its content type: a typo'd field, a value outside an enum or a nested sort field no longer compiles. Adds `ContentPathOf<C>` and `SortableFieldOf<C>`.

A collection query with a content filter or sort reaches only records stored at the handle's version, since a predicate in the handle's shape cannot be translated into another version's. Its page sets `skipped.older` or `skipped.newer` when records at another version match the rest of the query.
