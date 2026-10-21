---
'@haverstack/record-adapter-do-sqlite': minor
'@haverstack/record-adapter-sqlite': minor
'@haverstack/adapter-conformance': minor
'@haverstack/core': minor
---

A SQLite statement's text and bound parameters no longer grow with a query's size. Every caller-sized part of a query binds as one table of rows: lists, permission sets, `sort.contentFieldByType`'s entries, and the content conditions — every `filter.content` and `filter.contentPresent` key and every `filter.contentByType` arm — whose paths one recursive walk per condition resolves. Durable Object SQLite now answers queries at the declared `contentByType` and `contentFieldByType` caps, and content filters of any size, instead of failing with `too many SQL variables` or `statement too long`.

A content filter value now matches only a value of its own JSON type in the SQLite adapters, as `===` does: `true` no longer matches `1`. A content filter path may be 33 segments, the depth that reaches the deepest value a write accepts. The conformance suite holds every adapter to both, and to a multi-valued path satisfying both `contentPresent` and a `null` filter.
