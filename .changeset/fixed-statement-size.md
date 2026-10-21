---
'@haverstack/record-adapter-do-sqlite': minor
'@haverstack/record-adapter-sqlite': minor
'@haverstack/adapter-conformance': minor
'@haverstack/core': minor
'@haverstack/wire-types': minor
'@haverstack/conformance-fixtures': minor
---

A SQLite statement's text and bound parameters no longer grow with a query's size. Every caller-sized part of a query binds as one table of rows: lists, permission sets, `sort.contentFieldByType`'s entries, and the content conditions — every `filter.content` and `filter.contentPresent` key and every `filter.contentByType` arm — whose paths one recursive walk per condition resolves. Durable Object SQLite no longer fails a query with `too many SQL variables` or `statement too long`, however many per-Type keys or content conditions it carries.

The per-Type caps `filter.contentByType` and `sort.contentFieldByType` are now `number | null`, `null` stating no limit. `MemoryAdapter` and the SQLite adapters declare `null`, since nothing bounds the count locally; a cap is for a server bounding its own cost. `null` means the same on a cap and a limit: no limit stated, with the server's own bound still answering. `normalizeCapabilities()` reads a stated `null` cap as no limit and an absent or malformed one as `0`, and now reads `filter.contentPresent` as `false` beside `filter.content: 'none'`, as it already read both caps as `0`. `admitsKeys(cap, keys)` in `@haverstack/core/adapter` is the one comparison against a cap. A discovery fixture pins a stated `null` cap.

A content filter value now matches only a value of its own JSON type in the SQLite adapters, as `===` does: `true` no longer matches `1`. A content filter path may be 33 segments, the depth that reaches the deepest value a write accepts. The conformance suite holds every adapter to both, and to a multi-valued path satisfying both `contentPresent` and a `null` filter.
