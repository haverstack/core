---
'@haverstack/record-adapter-do-sqlite': minor
'@haverstack/record-adapter-sqlite': patch
'@haverstack/adapter-conformance': minor
'@haverstack/core': patch
---

A SQLite statement's text and bound parameters no longer grow with a query's size. Content conditions — every `filter.content` and `filter.contentPresent` key and every `filter.contentByType` arm — bind as one table of rows whose paths are walked by a recursive query, and `sort.contentFieldByType`'s entries bind as one list, so Durable Object SQLite answers queries at the declared `contentByType` and `contentFieldByType` caps, and content filters of any size, instead of failing with `too many SQL variables` or `statement too long`. The conformance suite now holds every adapter to a multi-valued path satisfying both `contentPresent` and a `null` content filter, and the content filter path cap is the content nesting cap itself rather than a second constant.
