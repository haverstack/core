---
'@haverstack/core': minor
---

A collection's `filter.content`, `filter.contentPresent` and `sort.contentField` are typed from its content type: a typo'd field, a value outside an enum or a nested sort field no longer compiles. Adds `ContentPathOf<C>` and `SortableFieldOf<C>`.
