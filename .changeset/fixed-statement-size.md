---
'@haverstack/record-adapter-do-sqlite': minor
'@haverstack/record-adapter-sqlite': minor
'@haverstack/adapter-conformance': minor
'@haverstack/core': minor
'@haverstack/wire-types': minor
'@haverstack/conformance-fixtures': minor
---

A SQLite statement's text and bound parameters no longer grow with a query's size. Every caller-sized part of a query binds as one table of rows: lists, permission sets, `sort.contentFieldByType`'s entries, and the content conditions — every `filter.content` and `filter.contentPresent` key and every `filter.contentByType` arm — whose paths one recursive walk per condition resolves. Durable Object SQLite no longer fails a query with `too many SQL variables` or `statement too long`, however many per-Type keys or content conditions it carries.

`filter.contentByType` and `sort.contentFieldByType` are now booleans, like `filter.contentPresent`: a per-Type shape holds any number of keys, as every other part of a query does, and a server bounds what one costs it by its query deadline. A collection facing `false` queries its handle's version alone and reports the rest as `skipped`, as it did at a cap of `0`; partial narrowing to the newest versions that fit is gone. `normalizeCapabilities()` reads both as `true` only when stated, and now reads `filter.contentPresent` as `false` beside `filter.content: 'none'`, as it reads both per-Type flags.

A content filter value now matches only a value of its own JSON type in the SQLite adapters, as `===` does: `true` no longer matches `1`. A content filter path may be 33 segments, the depth that reaches the deepest value a write accepts. The conformance suite holds every adapter to both, and to a multi-valued path satisfying both `contentPresent` and a `null` filter.
