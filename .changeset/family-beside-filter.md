---
'@haverstack/core': minor
'@haverstack/adapter-api': patch
'@haverstack/conformance-fixtures': patch
---

A type family is a query directive, not a filter condition: `baseId` moves from `RecordFilter` to the top level of `StackQuery`, beside `presentAt`, and from `ChangeFilter` to the top level of `SubscribeOptions`. Write `query({ baseId: 'com.example/note', filter: { … } })` and `subscribe(handler, { baseId, filter })`; `filter.baseId` is gone. `filter` now holds only conditions an adapter matches, so `AdapterFilter` is removed and `AdapterQuery` takes a plain `RecordFilter`. `assertValidBaseIdFilter()` is replaced by `assertValidFamilies(baseId)`, and a versioned `baseId` is refused at the path `baseId` rather than `filter.baseId`.

`parseQueryBody()` refuses a top-level `baseId`; a `filter.baseId` is now an unknown filter key and refused as one. `parseChangeParams()` returns `?baseId=` as `baseId` beside `filter`. `CollectionQuery` and `CollectionSubscribeOptions` omit the top-level `baseId`, which belongs to the collection.
