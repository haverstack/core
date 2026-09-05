---
'@haverstack/core': minor
'@haverstack/sqlite-shared': minor
'@haverstack/adapter-api': minor
'@haverstack/conformance-fixtures': minor
---

Add `filter.contentPresent`, the question an exact-match filter value cannot ask: which records hold a value at a path at all. A `null` content filter already matched "no value at the path, or a value that is null" — this is the other side, and without it an app wanting only the records that _have_ a field had to carry a redundant boolean beside it.

```ts
query({ filter: { contentPresent: ['publishedAt'] } }); // published articles
query({ filter: { content: { publishedAt: null } } }); // drafts
```

It lists paths, all of which must hold a value (an intersection, like `tags`), and an empty list filters nothing. A path holds a value when at least one non-null value is reachable at it, so it reads an array element-wise exactly as a content filter does. Where a path is multi-valued the two filters are not strict complements — `tags: [null, 'x']` satisfies both — which falls out of element-wise matching rather than being a special case.

`AdapterCapabilities` gains `contentPresenceQuery`, a third content flag beside `nestedContentQuery` and for the same reason: a server promising to match a content value has not thereby promised to answer whether one is there, and reading it as such would hand a client the unfiltered superset that ignoring the filter produces. It travels in the `POST /records/query` body only, as `filter.content` does.
