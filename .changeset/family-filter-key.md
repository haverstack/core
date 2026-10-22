---
'@haverstack/core': minor
'@haverstack/adapter-api': minor
'@haverstack/adapter-conformance': minor
'@haverstack/conformance-fixtures': minor
'@haverstack/adapter-local': minor
'@haverstack/record-adapter-sqlite': minor
'@haverstack/record-adapter-do-sqlite': minor
---

`filter.baseId` is a condition every adapter matches, like `typeId`: a record matches when its `typeId` with the `@version` suffix stripped equals one of the values. `Stack` no longer resolves it to a `typeId` set against registered Types before the adapter call, so `queryRecords()` and `queryReadable()` receive it as given, and `AdapterFilter` is removed — `AdapterQuery` takes a plain `RecordFilter`. `MemoryAdapter` and the SQLite adapters match it; the SQLite ones as a `type_id` range, so the index still serves it. The conformance suite holds every adapter to it, including that a family never matches one that only shares its prefix.

It travels on the wire like any other key: `?baseId=` on `GET /records` (repeatable, as on `GET /changes`) and `filter.baseId` in a `POST /records/query` body. The parsers decode it instead of refusing it, `APIAdapter` sends it, and `assertQueryTravels()` refuses only `presentAt`. A new fixture, `query-by-type-family`, pins the encoding.

Every other family an adapter is handed is matched the same way:

- A `Reach` is over families: `fence`, `within.types` and `within.authored.types` hold `BaseId`s, and `queryReadable()` receives the reach as `ScopedStack` built it. `Reach` no longer takes a type parameter, and `inReach(record, reach)` matches by the record's family.
- `deleteUnreferencedAttachmentRecords(fileId, metadataBaseId)` takes the `_attachment` family rather than its registered versions.

`includeUnlisted` moves from `SubscribeOptions` into `ChangeFilter`, so a subscription writes `subscribe(handler, { filter: { includeUnlisted: true } })` as a query writes `filter.includeUnlisted`. `?includeUnlisted=` on `GET /changes` is unchanged; `parseChangeParams()` returns it as `filter.includeUnlisted`, and `ParsedChangeParams` no longer has an `includeUnlisted` field.
