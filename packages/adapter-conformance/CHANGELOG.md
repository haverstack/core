# @haverstack/adapter-conformance

## 0.13.0

### Minor Changes

- [#470](https://github.com/haverstack/core/pull/470) [`b02e69c`](https://github.com/haverstack/core/commit/b02e69c4675e7397d2fca76c314261a9744053bf) Thanks [@cuibonobo](https://github.com/cuibonobo)! - A stack can be copied whole between adapters, authorship and history included.
  - `copyStack(from, create)` in `@haverstack/core/adapter` copies every Record, soft-deleted and unlisted ones too, with its versions and journal, plus every Type and every blob, into a new store `create` makes from the source's `_config` record and its history, and returns it open. `_config` travels as every Record does. Both ends must list their blobs, and the target must hold nothing yet, so `APIAdapter` cannot yet be copied from. Copying into a `LocalAdapter` store is an export; copying out of one is an import.
  - It writes through the new optional `StackRecordAdapter.importRecord(record, { versions, journal })`, which every local adapter implements and `APIAdapter` does not.
  - `StackIdentity`, `CreateStore`, `StoreSeed`, `newStoreSeed()` and `identityOf()` are exported beside it. Every adapter that creates stores takes a `seed` in place of `ownerEntityId` and `timezone`: the `_config` record, with its history, a new store is created holding. A seed only creates: storage already holding a store refuses it, and `NativeSQLiteRecordAdapter`/`LocalAdapter` take no `create` beside one. `MemoryAdapter` now holds a real `_config` record.
  - Every SQLite store names its layout in a one-row `format` table, and opening one in another layout throws the new `FormatMismatchError` (from `@haverstack/core/adapter`). A new store is written whole, tables included, in one transaction — a table of the same name already in the database fails the create — and a failed `NativeSQLiteRecordAdapter.open()` removes a file it created.
  - `OwnerMismatchError` reads `<where> is owned by "X", not "Y"`, and `copyStack()` throws it too.
  - `saveVersion()` is removed from the adapter contract: `importRecord()` is the one standalone history write.
  - `@haverstack/adapter-conformance` checks `importRecord()` in the record suite and adds `runCopyConformance()`, which holds a full adapter to both halves of a copy.

### Patch Changes

- Updated dependencies [[`e0475d2`](https://github.com/haverstack/core/commit/e0475d2fdd09581310d819d3d2b5effe4191603c), [`b02e69c`](https://github.com/haverstack/core/commit/b02e69c4675e7397d2fca76c314261a9744053bf), [`7f3d108`](https://github.com/haverstack/core/commit/7f3d108100dbb7a358fdc8d1bb6e3edb2455ec45)]:
  - @haverstack/core@0.44.0

## 0.12.0

### Minor Changes

- [#457](https://github.com/haverstack/core/pull/457) [`29041aa`](https://github.com/haverstack/core/commit/29041aad7002ab5dc5b89ee306aaf6b39c102d55) Thanks [@cuibonobo](https://github.com/cuibonobo)! - Aspect writes (`setParent`, `setUnlisted`, `editAssociations`, `setAssociations`, `editAccess`, `setAccess`) never land on a record soft-deleted after `Stack` read it; such a write is now refused with `409`. `StackRecordAdapter`'s six aspect writes refuse a soft-deleted record inside the write, before `ifVersion` and `expectSet`, with the `StackConflictError` that `softDeletedRefusal()`, exported from `@haverstack/core/adapter`, builds.

- [#454](https://github.com/haverstack/core/pull/454) [`73ed256`](https://github.com/haverstack/core/commit/73ed2566ebff1c32b32b6d24fef8d76344890dca) Thanks [@cuibonobo](https://github.com/cuibonobo)! - Association and permission writes are a compare-and-swap on the set they read, so concurrent edits can no longer leave a `_group` with no admin or a grantee holding `write` without `read`. `editAssociations`, `setAssociations`, `editAccess` and `setAccess` on `StackRecordAdapter` take an `expectSet` option (`ElementWriteOptions`) and throw `ElementSetMovedError` when the stored set differs; `Stack` re-reads and re-checks on that error alone, until the write lands or a rule refuses it, and its journal delta is now computed against the set the write replaced. `ElementSetMovedError` and `sameAssociationSet` are exported from `@haverstack/core/adapter` for adapters to compare with.

- [#467](https://github.com/haverstack/core/pull/467) [`b263486`](https://github.com/haverstack/core/commit/b263486c238257dac15be43e7bae68d4f110d062) Thanks [@cuibonobo](https://github.com/cuibonobo)! - `filter.baseId` is a condition every adapter matches, like `typeId`: a record matches when its `typeId` with the `@version` suffix stripped equals one of the values. `Stack` no longer resolves it to a `typeId` set against registered Types before the adapter call, so `queryRecords()` and `queryReadable()` receive it as given, and `AdapterFilter` is removed — `AdapterQuery` takes a plain `RecordFilter`. `MemoryAdapter` and the SQLite adapters match it; the SQLite ones as a `type_id` range, so the index still serves it. The conformance suite holds every adapter to it, including that a family never matches one that only shares its prefix.

  It travels on the wire like any other key: `?baseId=` on `GET /records` (repeatable, as on `GET /changes`) and `filter.baseId` in a `POST /records/query` body. The parsers decode it instead of refusing it, `APIAdapter` sends it, and `assertQueryTravels()` refuses only `presentAt`. A new fixture, `query-by-type-family`, pins the encoding.

  Every other family an adapter is handed is matched the same way:
  - A `Reach` is over families: `fence`, `within.baseIds` and `within.authored.baseIds` (renamed from `types`) hold `BaseId`s, and `queryReadable()` receives the reach as `ScopedStack` built it. `Reach` no longer takes a type parameter, and `inReach(record, reach)` matches by the record's family.
  - `deleteUnreferencedAttachmentRecords(fileId, metadataBaseId)` takes the `_attachment` family rather than its registered versions.

  `includeUnlisted` moves from `SubscribeOptions` into `ChangeFilter`, so a subscription writes `subscribe(handler, { filter: { includeUnlisted: true } })` as a query writes `filter.includeUnlisted`. `?includeUnlisted=` on `GET /changes` is unchanged; `parseChangeParams()` returns it as `filter.includeUnlisted`, and `ParsedChangeParams` no longer has an `includeUnlisted` field.

- [#464](https://github.com/haverstack/core/pull/464) [`18608e5`](https://github.com/haverstack/core/commit/18608e50a8c77288f6c235f006de87193b9bea52) Thanks [@cuibonobo](https://github.com/cuibonobo)! - A SQLite statement's text and bound parameters no longer grow with a query's size. Every caller-sized part of a query binds as one table of rows: lists, permission sets, `sort.contentFieldByType`'s entries, and the content conditions — every `filter.content` and `filter.contentPresent` key and every `filter.contentByType` arm — whose paths one recursive walk per condition resolves. Durable Object SQLite no longer fails a query with `too many SQL variables` or `statement too long`, however many per-Type keys or content conditions it carries.

  `filter.contentByType` and `sort.contentFieldByType` are now booleans, like `filter.contentPresent`: a per-Type shape holds any number of keys, as every other part of a query does, and a server bounds what one costs it by its query deadline. A collection facing `false` queries its handle's version alone and reports the rest as `skipped`, as it did at a cap of `0`; partial narrowing to the newest versions that fit is gone. `normalizeCapabilities()` reads both as `true` only when stated, and now reads `filter.contentPresent` as `false` beside `filter.content: 'none'`, as it reads both per-Type flags.

  A content filter value now matches only a value of its own JSON type in the SQLite adapters, as `===` does: `true` no longer matches `1`. A content filter path may be 33 segments, the depth that reaches the deepest value a write accepts. The conformance suite holds every adapter to both, and to a multi-valued path satisfying both `contentPresent` and a `null` filter.

- [#451](https://github.com/haverstack/core/pull/451) [`f810209`](https://github.com/haverstack/core/commit/f8102090ae6ccf2cc971c901c6258a83c0c51afe) Thanks [@cuibonobo](https://github.com/cuibonobo)! - Every aspect of a record has one narrow write verb, so no call can change more than its caller means to. `mutate()` and its change set are removed: content is written with `patchContent()`, containment with `setParent(id, parentId | null)`, listing with `setUnlisted(id, boolean)`, associations with `editAssociations()` or `setAssociations()`, and permissions with `editAccess()` or `setAccess()`. `edit*` applies a list of `add`/`remove` edits; `set*` replaces the whole set. `associate()`, `dissociate()`, `grantAccess()` and `revokeAccess()` are removed in favour of the `edit*` verbs, and `amendAssociations()`/`amendAccess()` are renamed to them. `deleteAndReturn()` is removed: `delete()` always returns `{ record, referencedFileIds }`.

  Every write accepts `ifVersion` and always checks it, including the writes that never bump `version`, so a publish can fence `setAccess()` and `setUnlisted()` to the content it reviewed.

  `StackRecordAdapter` narrows to match: `mutateRecord()` and `amendAssociations()` are replaced by `patchContent()`, `setParent()`, `setUnlisted()`, `editAssociations()`, `setAssociations()`, `editAccess()` and `setAccess()`, each taking `ifVersion`. `BumpVersionOptions`, `RecordChangeSet`, `assertOneSurface()`, `partitionAssociations()` and `AUTHORITY_ASSOCIATION_KINDS` are removed. SQLite adapters store permissions in a `permissions` table of their own.

  On the wire, `PATCH /records/:id` is replaced by `PATCH /records/:id/content` (a bare patch body), `PUT /records/:id/parent` and `PUT /records/:id/unlisted`; `PUT /records/:id/associations` and `PUT /records/:id/permissions` replace a set; `PATCH /entity` becomes `PATCH /entity/content`. Every write endpoint reads and checks `If-Match`. `changesFromWireBody()` and `parseEntityPatchBody()` are replaced by `parseContentPatchBody()`, `parseParentBody()`, `parseUnlistedBody()`, `parseAssociationsBody()` and `parsePermissionsBody()`.

- [#465](https://github.com/haverstack/core/pull/465) [`ffc1b1a`](https://github.com/haverstack/core/commit/ffc1b1a17d3cae8878a44a61603480e5fd4568f7) Thanks [@cuibonobo](https://github.com/cuibonobo)! - `Stack` resolves every query default before an adapter sees the query: the sort (`createdAt`, newest first, when none is named), its direction, and the page size (50, capped at 1000). `queryRecords()` and `queryReadable()` take an `AdapterQuery` whose `sort` and `limit` are always present, built by `resolveQuery()`, which `@haverstack/core/adapter` exports beside `AdapterQuery` and `AdapterSort`. No adapter carries a default of its own, and `APIAdapter` always sends the sort, direction and limit.

  `createdAt` is the floor of `sort.fields`: every adapter orders by it, and `normalizeCapabilities()` reads it into any list a server declares. The conformance suite checks that an adapter declares it.

  Every query entry point runs two checks, both exported from `@haverstack/core/adapter`: `resolveQuery()` for the query's shape, and `assertQueryCapabilities(query, capabilities)` for its filter and sort together. `assertSortCapability` is no longer exported. A sort must name exactly one of `field`, `contentField` or `contentFieldByType`, so a `direction` alone, in process or as `?direction=` on the wire, is refused.

  Every `limit` — on `query()`, `getVersions()` and `getJournal()` — is a positive integer, and anything else is refused with `StackBadRequestError` by `Stack`. A journal `limit` of 0 is now refused. The wire parsers decode shape only and leave the range to `Stack`: `parseQueryBody()` decodes a numeric `limit` as given, and `parsePositiveInt` is renamed `parseUnsignedInt`, since it always accepted 0.

  `APIAdapter.queryRecords()` trusts the query it is given. `Stack` has already checked it against `APIAdapter`'s capabilities, so a query the server cannot answer is refused with the same `StackBadRequestError`, naming the capability, that any adapter's would get, and still before a request is sent. `APIAdapterCapabilityError` now covers only the endpoints discovery advertises beside `capabilities` (`'changes'` and `'installs'`), and `@haverstack/adapter-api` no longer re-exports `MissingCapability`. `AdapterQuery` carries no `presentAt`, which `Stack` applies itself. `resolveQuery()` takes a `PlainQuery`, the same shape `parseQueryParams()` and `parseQueryBody()` now return.

- [#461](https://github.com/haverstack/core/pull/461) [`e707ca6`](https://github.com/haverstack/core/commit/e707ca6d3d68c34a26015f507228c7549d5844e7) Thanks [@cuibonobo](https://github.com/cuibonobo)! - State what a scoped requester may do as a `Reach` per verb — `create`, `read`, `update`, `delete` — and answer every grant- and permission-based gate from it: a type fence for a delegated principal, and within it the types reached whole, the types reached where the subject authored, and the permission-element sets that carry the verb, a `write` beside its grantee's `read` or `anyone`. `get()`, refusals and the change feed ask the read reach of one record, write gates ask the update or delete reach, `create()` asks the create reach of the record it would make, and `query()` hands the read reach to the adapter's new `queryReadable(query, reach)`, which matches it as one more condition — so pages, cursors and whether a cursor comes back are decided among readable records alone, and a cursor never names a record the requester cannot read. A requester's grants, rosters and reaches are each read at most once per operation, and a subscription holds them until a `_grant` or `_group` event clears them. `asEntity()`/`asActor()` refuse with `ScopeUnavailableError` — replacing `RelayScopeError` — over a stack whose adapter lacks `queryReadable()` or relays changes. `MemoryAdapter`, the SQLite adapters and `LocalAdapter` implement it; `inReach()` in `@haverstack/core/adapter` is the reference predicate, and the conformance suite holds adapters to it. The SQLite adapters bind every list a query carries — a filter's type, app and author lists, its tags, and every list in a reach — as one JSON parameter, so neither a reach nor a filter list of any length runs into Durable Object SQLite's 100-parameter cap. `MemoryAdapter`'s cursor names the last record a page held rather than an offset, so a page resumes after it however the matched set moved, as the SQL adapters' cursors do.

### Patch Changes

- Updated dependencies [[`29041aa`](https://github.com/haverstack/core/commit/29041aad7002ab5dc5b89ee306aaf6b39c102d55), [`73ed256`](https://github.com/haverstack/core/commit/73ed2566ebff1c32b32b6d24fef8d76344890dca), [`b263486`](https://github.com/haverstack/core/commit/b263486c238257dac15be43e7bae68d4f110d062), [`52f9486`](https://github.com/haverstack/core/commit/52f9486d9e5a0a7c6a6c6235e4336223e4c90cfa), [`18608e5`](https://github.com/haverstack/core/commit/18608e50a8c77288f6c235f006de87193b9bea52), [`f810209`](https://github.com/haverstack/core/commit/f8102090ae6ccf2cc971c901c6258a83c0c51afe), [`70e8c6a`](https://github.com/haverstack/core/commit/70e8c6a4886f84f57498100df28eb8a7b6e91b99), [`ffc1b1a`](https://github.com/haverstack/core/commit/ffc1b1a17d3cae8878a44a61603480e5fd4568f7), [`03a6199`](https://github.com/haverstack/core/commit/03a619915d042753a6cd5c2e1801e75677f99595), [`e707ca6`](https://github.com/haverstack/core/commit/e707ca6d3d68c34a26015f507228c7549d5844e7)]:
  - @haverstack/core@0.43.0

## 0.11.0

### Minor Changes

- [#449](https://github.com/haverstack/core/pull/449) [`a40cee0`](https://github.com/haverstack/core/commit/a40cee01aaaf37baf95be802f266ff1ee6ce320d) Thanks [@cuibonobo](https://github.com/cuibonobo)! - Migrations are declared steps. `migration(from, to, steps)` takes a list built from `rename`, `map`, `add`, `drop` and `derive`, replacing the function form, and checks the list against both handles' schemas when it runs: a step naming a field that is not there, a carried field the target would refuse, or a required field nothing produces throws `StackMigrationError`. `Migration` carries its `steps`.

  A collection's content filter or sort now spans the older versions its migrations translate it to, rather than only the handle's version. A key across a `rename` or `add` translates; one across a `derive`, or a sort across a `map`, narrows that version and sets `skipped.older` as before. Two query shapes carry it, each gated by a new capability that is a cap on keys: `filter.contentByType` (a content predicate per `typeId`, never beside `content` or `contentPresent`) and `sort.contentFieldByType` (a sort field or a reduced constant per `typeId`). `StackCapabilities` gains `filter.contentByType` and `sort.contentFieldByType`; local adapters declare 64, and `normalizeCapabilities()` reads an absent or malformed cap as 0. `parseQueryBody()` accepts both shapes. Conformance fixtures pin both shapes and their 400s, and the adapter conformance suite checks them.

- [#433](https://github.com/haverstack/core/pull/433) [`fdca4ca`](https://github.com/haverstack/core/commit/fdca4ca25760b19a79bc660404ebf95cf9c9048b) Thanks [@cuibonobo](https://github.com/cuibonobo)! - `enum` is a field kind: `{ kind: 'enum', values: [...] }` replaces `{ kind: 'string', enum: [...] }`. `defineType()` refuses the `enum` key on any field. `isCompatible()` now checks enums: a required enum accepts only an enum candidate whose values it lists all of, and a required `string` or `text` accepts an enum. An enum becoming a plain `string` is additive; a `string` becoming an enum needs a version bump. A typed read types an enum field as its listed values or any other string (`StoredContentOf`, `UnlistedValue`) and no longer throws on an unlisted value, since an enum can widen in place; typed writes still take only the listed values (`ContentOf`, `PatchOf`). `migration()` types both sides as `StoredContentOf`, so a step carries an unlisted value through. A typed `subscribe()` delivers a record that `migrateAll()` moves off the handle's version without its `record`, instead of throwing in the dispatcher. Conformance fixtures pin a 422 for a value outside the list and a 409 for removing values. The adapter conformance suite checks that an enum field sorts by value.

### Patch Changes

- Updated dependencies [[`7d30040`](https://github.com/haverstack/core/commit/7d30040c4b61b8e5881604d0c042fec9c7e45122), [`98401c0`](https://github.com/haverstack/core/commit/98401c0a1a8b86fd2bfec74072ca3c3504320b66), [`a40cee0`](https://github.com/haverstack/core/commit/a40cee01aaaf37baf95be802f266ff1ee6ce320d), [`fdca4ca`](https://github.com/haverstack/core/commit/fdca4ca25760b19a79bc660404ebf95cf9c9048b), [`c427f43`](https://github.com/haverstack/core/commit/c427f435620c5766121723a54516f5a68df63561), [`90d800a`](https://github.com/haverstack/core/commit/90d800a8e86c079855a17627582f015186ffe081), [`7d30040`](https://github.com/haverstack/core/commit/7d30040c4b61b8e5881604d0c042fec9c7e45122), [`da5148b`](https://github.com/haverstack/core/commit/da5148bdb3e25e770e947df0c4c2af5b2a6f0f44), [`44fc3f6`](https://github.com/haverstack/core/commit/44fc3f645839c3a5a5eef3463826dcc0098bf089), [`d0b7950`](https://github.com/haverstack/core/commit/d0b795047ec9f8920a717a075f091cfa2462dc66), [`f616aaa`](https://github.com/haverstack/core/commit/f616aaa741c97fe1de1cfb262081e1f378082051), [`9b4adef`](https://github.com/haverstack/core/commit/9b4adef9bbb205ef27c161724dd2fe863254ffd2), [`89e0a07`](https://github.com/haverstack/core/commit/89e0a07b03ade71449cd20b7ad0333761c39a41f), [`55c33ba`](https://github.com/haverstack/core/commit/55c33ba3c0a55ec01796bce8b633fbad4a79cf76)]:
  - @haverstack/core@0.42.0

## 0.10.0

### Minor Changes

- Released for a breaking change in `@haverstack/core`.

### Patch Changes

- Updated dependencies [[`6782ac9`](https://github.com/haverstack/core/commit/6782ac9a5c4e9211d979011f6a5eb46068768760), [`de4e587`](https://github.com/haverstack/core/commit/de4e587155f36cf077f47311b2677905211ee062), [`8049dd0`](https://github.com/haverstack/core/commit/8049dd0fda562d9e491e375613e2378fc93a63a8), [`ef500b8`](https://github.com/haverstack/core/commit/ef500b8cc0ffde261ae1294ac54f8a64bd9428d3)]:
  - @haverstack/core@0.41.0

## 0.9.0

### Minor Changes

- [#390](https://github.com/haverstack/core/pull/390) [`a23b58b`](https://github.com/haverstack/core/commit/a23b58bf2cb911bb094dcfa9533c57454f06ca24) Thanks [@cuibonobo](https://github.com/cuibonobo)! - `StackRecordAdapter.associate()` and `dissociate()` are replaced by `amendAssociations(id, changes, opts?)`, which applies a list of `AssociationEdit` as one write. `POST /records/:id/associations` and `/permissions` take `{ changes }` and the `/delete` sub-paths are removed. `parseAssociationEditsBody()` and `assertOneSurface()` are exported from `@haverstack/core`.

- [#387](https://github.com/haverstack/core/pull/387) [`090b27c`](https://github.com/haverstack/core/commit/090b27c1e88aa24b151073b0e1eb95c881f94ce1) Thanks [@cuibonobo](https://github.com/cuibonobo)! - The blob suite requires `getBlob()` to return a plain `Uint8Array` (not a subclass such as `Buffer`) and checks that the returned array and the array passed to `putBlob()` are independent of the stored bytes.

- [#388](https://github.com/haverstack/core/pull/388) [`20f636a`](https://github.com/haverstack/core/commit/20f636abf14ff485e1c493707e1e1e35a051d07b) Thanks [@cuibonobo](https://github.com/cuibonobo)! - Adds a record-adapter conformance test that a content field set to `undefined` reads back absent.

- [#390](https://github.com/haverstack/core/pull/390) [`c5da1f5`](https://github.com/haverstack/core/commit/c5da1f53bddfcf8f68cabb10a9d2df48104c8d71) Thanks [@cuibonobo](https://github.com/cuibonobo)! - A journal `remove` names its subject `association` instead of `previous`, so `previous` appears only on `repoint`. `AssociationEdit` is exported: the journal's shape without `repoint`.

- [#383](https://github.com/haverstack/core/pull/383) [`bef7f3e`](https://github.com/haverstack/core/commit/bef7f3eaed7f034c744f6c4c95086c244ddac80d) Thanks [@cuibonobo](https://github.com/cuibonobo)! - `getVersions()` takes an optional `VersionsQuery` (`beforeVersion`, `limit`) and pages newest first, in the shape of `getJournal()`'s `JournalQuery`; omitting both reads every version. `GET /records/:id/versions` takes `?limit=` and `?beforeVersion=` and answers `{ versions, cursor }`, with `parseVersionsParams()` in `@haverstack/core/wire` to decode them. `APIAdapter` follows `cursor` to the end when no `limit` is given.

- [#382](https://github.com/haverstack/core/pull/382) [`abed267`](https://github.com/haverstack/core/commit/abed2670c3a9017d21f23b4b6a31bde7cd3cde8a) Thanks [@cuibonobo](https://github.com/cuibonobo)! - Rename the change kind `deleted` to `removed`. It names what a subscriber does with its copy, and covers both a soft delete and an unlist; `ops` still says which. The set stays `created`, `changed`, `removed`, `purged`, and the `?kind=` filter and journal `kind` column take the new value.

- [#382](https://github.com/haverstack/core/pull/382) [`5813d84`](https://github.com/haverstack/core/commit/5813d84e8a909254875e67de22e157ed11efb070) Thanks [@cuibonobo](https://github.com/cuibonobo)! - `MemoryAdapter.getVersions()` returns versions newest first, matching the SQLite adapters and `APIAdapter`. The order is now stated in the spec and `StackRecordAdapter`, and pinned by an `adapter-conformance` test.

### Patch Changes

- [#384](https://github.com/haverstack/core/pull/384) [`d122a0a`](https://github.com/haverstack/core/commit/d122a0ad5f66bac3267f46a651f0122bb96e09e5) Thanks [@cuibonobo](https://github.com/cuibonobo)! - A sort that names a field now defaults to ascending, native or content field alike, as `ORDER BY` does; a query with no sort still returns `createdAt`, newest first. `Stack.query()` resolves both defaults before an adapter sees the query, so `queryRecords()` always receives an explicit `direction`. `listTypeGrants()` states its newest-first order rather than inheriting it.
- Updated dependencies [[`a23b58b`](https://github.com/haverstack/core/commit/a23b58bf2cb911bb094dcfa9533c57454f06ca24), [`20f636a`](https://github.com/haverstack/core/commit/20f636abf14ff485e1c493707e1e1e35a051d07b), [`fb55e1f`](https://github.com/haverstack/core/commit/fb55e1fb992f106d42239b295cf9ba93b2b2c81b), [`cb9643a`](https://github.com/haverstack/core/commit/cb9643a48c4ed8357cd1c2b2c90aeabbc36245aa), [`a1bea0e`](https://github.com/haverstack/core/commit/a1bea0e9ee2a420b238cbaa5592ec88c35976ca4), [`c5da1f5`](https://github.com/haverstack/core/commit/c5da1f53bddfcf8f68cabb10a9d2df48104c8d71), [`38e7e9a`](https://github.com/haverstack/core/commit/38e7e9a852b69871ef591cea6506ed0d42b9839d), [`090b27c`](https://github.com/haverstack/core/commit/090b27c1e88aa24b151073b0e1eb95c881f94ce1), [`1963d5d`](https://github.com/haverstack/core/commit/1963d5da5d5d268768641b18f2f66bc50cc29a11), [`bef7f3e`](https://github.com/haverstack/core/commit/bef7f3eaed7f034c744f6c4c95086c244ddac80d), [`1568139`](https://github.com/haverstack/core/commit/15681396bd7e8c40f8fe7c4674dc25bd34ae64d4), [`9326323`](https://github.com/haverstack/core/commit/9326323f9a0546deedafe21db09cbaee32e5f77e), [`abed267`](https://github.com/haverstack/core/commit/abed2670c3a9017d21f23b4b6a31bde7cd3cde8a), [`dba0895`](https://github.com/haverstack/core/commit/dba0895678fefe80452b20ecfd14215e65a10736), [`d122a0a`](https://github.com/haverstack/core/commit/d122a0ad5f66bac3267f46a651f0122bb96e09e5), [`a4f7b74`](https://github.com/haverstack/core/commit/a4f7b74849941e5b84d062879090e46359aad827), [`721cbe3`](https://github.com/haverstack/core/commit/721cbe326806e64ead903fddd6034658b6e5d7f8), [`22a33cb`](https://github.com/haverstack/core/commit/22a33cbf42e80f2311090ae67341607c7f4d976e), [`9e33c53`](https://github.com/haverstack/core/commit/9e33c53e6fb963c62ba36161acedeedea32167ab), [`5813d84`](https://github.com/haverstack/core/commit/5813d84e8a909254875e67de22e157ed11efb070)]:
  - @haverstack/core@0.40.0

## 0.8.0

### Minor Changes

- Released for a breaking change in `@haverstack/core`.

### Patch Changes

- Updated dependencies [[`a431168`](https://github.com/haverstack/core/commit/a43116869768b7f6e7f7a7bb9712d6821d831498), [`4a3bc8e`](https://github.com/haverstack/core/commit/4a3bc8e86f69296ce18413e2225e6f35557a3b1c)]:
  - @haverstack/core@0.39.0

## 0.7.0

### Minor Changes

- [#347](https://github.com/haverstack/core/pull/347) [`cd467d9`](https://github.com/haverstack/core/commit/cd467d90cab977001bc4b097f9291c6c49fae226) Thanks [@cuibonobo](https://github.com/cuibonobo)! - Align the adapter vocabulary with the client's.
  - The version precondition is `ifVersion` on both sides of the `Stack`/adapter boundary: `StackRecordAdapter` methods take the root export `IfVersionOptions` (`{ ifVersion?: number }`), and `ExpectedVersionOptions` is removed. `StackVersionConflictError.expectedVersion` and the wire payload are unchanged.
  - Capabilities have one name: `AdapterCapabilities` (from `@haverstack/core/adapter`) and its root alias `StackFeatures` are replaced by `StackCapabilities`, exported from the root, and `Stack.features`, `ScopedStack.features` and `StackClient.features` are renamed `capabilities`.
  - `StackBlobAdapter` methods are renamed `putBlob`, `getBlob`, `deleteBlob` and `listBlobs`, and `BlobFileInfo` is renamed `BlobInfo`, so "attachment" names only the record-backed `Stack` operation. `putAttachmentWithMetadata` keeps its name. The blob conformance suite's `listFiles` option is renamed `listBlobs`.

### Patch Changes

- [#351](https://github.com/haverstack/core/pull/351) [`546e28c`](https://github.com/haverstack/core/commit/546e28cf1d78f3a088d7962272a7d3bd70a9ff62) Thanks [@cuibonobo](https://github.com/cuibonobo)! - Follow-ups to the API consistency pass.
  - The `Stack` prefix is reserved for the `StackError` taxonomy. The local errors outside it are renamed: `StackClosedError` → `UseAfterCloseError` and `StackRelayScopeError` → `RelayScopeError`.
  - Every `@haverstack/core` export has exactly one entry point. `StackAdapter` moves from the root to `@haverstack/core/adapter`, beside its record and blob halves; `TokenSession` moves from the root to `@haverstack/core/wire`, beside `StackTokenStore` and `TokenInfo`; `ContentFilterReach` and `MissingCapability` are no longer exported from `@haverstack/core/adapter`, only the root; and `@haverstack/core/wire` no longer re-exports the root's errors (`StackValidationError`, and `StackQueryError` under its new name `StackBadRequestError`).
  - `LocalAdapter.openOrInitialize()` throws `LocalAdapterOwnerMismatchError` (with `expectedOwnerEntityId`, `actualOwnerEntityId` and `path`) on an owner mismatch, and releases the database lock before throwing. `APIAdapterOwnerMismatchError`'s `expectedOwner`/`actualOwner` fields are now `expectedOwnerEntityId`/`actualOwnerEntityId`, matching.
  - `DiskBlobAdapter` takes an options object, `new DiskBlobAdapter({ dir })`, like `S3BlobAdapter`.

- [#350](https://github.com/haverstack/core/pull/350) [`987d533`](https://github.com/haverstack/core/commit/987d53303099fc9478a5f6708651c8a898c3008d) Thanks [@cuibonobo](https://github.com/cuibonobo)! - Make every `ChangeOp` a verb and spell permanent deletion one way. The record-level ACL op `'permissions'` is now `'reshare'`. Permanent deletion is `purge` everywhere: `delete(id, { purge: true })` (was `{ hard: true }`), `deleteRecord(id, { purge: true })` on every adapter, `DELETE /records/:id?purge=true` on the wire (was `?hard=true`), and the op `'purge'` (was `'hard-delete'`), matching the existing `'purged'` kind.

- [#349](https://github.com/haverstack/core/pull/349) [`ad14212`](https://github.com/haverstack/core/commit/ad142122b11c74aee921e61441691c1914425ed2) Thanks [@cuibonobo](https://github.com/cuibonobo)! - Rename the change feed's resume cursor from `seq` to `cursor`, so it no longer shares a name with the journal's per-record `seq`. `RecordChange.seq` is now `RecordChange.cursor`, the `ready` frame carries `{"cursor": …}`, and `isValidSeq()` is now `isValidCursor()`. The journal window's exclusive bound `JournalQuery.sinceSeq` (and the `?sinceSeq=` query param) is now `afterSeq`.

- [#326](https://github.com/haverstack/core/pull/326) [`4caed17`](https://github.com/haverstack/core/commit/4caed174a242fac5698018a63762a53f9b642ff6) Thanks [@cuibonobo](https://github.com/cuibonobo)! - Record-level permission grantees now discriminate on `kind` instead of `scope`, matching type-level grant grantees: `{ kind: 'entity', entityId }` and `{ kind: 'group', groupId, role }`. The shared arms are exported as `Grantee`, which replaces `PermissionGrantee`, with `GroupRole` naming `'member' | 'admin'`; `GrantGrantee` is `Grantee` plus `{ kind: 'authenticated' }`. The `GrantTarget` alias is removed in favor of `GrantGrantee`. Relationship targets (`RelationshipTarget`, `RelationshipTargetPattern`) move to `kind` too — `{ kind: 'record' | 'entity' | 'external', … }` — so an entity target and an entity grantee are the same value.
- Updated dependencies [[`ce4ac6d`](https://github.com/haverstack/core/commit/ce4ac6da617549745aee4b7ccc1aacad3d8007b7), [`cd467d9`](https://github.com/haverstack/core/commit/cd467d90cab977001bc4b097f9291c6c49fae226), [`2f12d0a`](https://github.com/haverstack/core/commit/2f12d0a6ed6adab7d04cf858f566bad18826cdc9), [`546e28c`](https://github.com/haverstack/core/commit/546e28cf1d78f3a088d7962272a7d3bd70a9ff62), [`147bbdf`](https://github.com/haverstack/core/commit/147bbdf8e8ce50c5865875b0c56e410fee01994f), [`83ded9c`](https://github.com/haverstack/core/commit/83ded9c2274d5e1ca29e8de4fa714a9da5eff2d1), [`e36923c`](https://github.com/haverstack/core/commit/e36923cf3799f8d3a13176c23b293f4967e4928b), [`987d533`](https://github.com/haverstack/core/commit/987d53303099fc9478a5f6708651c8a898c3008d), [`fa9e4b8`](https://github.com/haverstack/core/commit/fa9e4b8be57a22b63bb63479f89644ea52bf038b), [`ad14212`](https://github.com/haverstack/core/commit/ad142122b11c74aee921e61441691c1914425ed2), [`4caed17`](https://github.com/haverstack/core/commit/4caed174a242fac5698018a63762a53f9b642ff6), [`e4c8628`](https://github.com/haverstack/core/commit/e4c862860111a090fe1b08cd63e2da71e62f1e56), [`40b3757`](https://github.com/haverstack/core/commit/40b3757a93a2dd1a68a7fbb40273efe3503719a6), [`e3057db`](https://github.com/haverstack/core/commit/e3057db5af528136270b3c418bb0021d3727d5a5), [`1b0e0c7`](https://github.com/haverstack/core/commit/1b0e0c73e386cd9adc178a8b56a72944bd334f46), [`7cffb1d`](https://github.com/haverstack/core/commit/7cffb1dc8e33993082aaa83599ba2e031a1c5cde)]:
  - @haverstack/core@0.38.0

## 0.6.0

### Minor Changes

- Released for a breaking change in `@haverstack/core`.

### Patch Changes

- Updated dependencies [[`11444f6`](https://github.com/haverstack/core/commit/11444f694cfa6b24fbe926cf7420d3523a3fa95f)]:
  - @haverstack/core@0.37.0

## 0.5.0

### Minor Changes

- Released for a breaking change in `@haverstack/core`.

### Patch Changes

- Updated dependencies [[`2465107`](https://github.com/haverstack/core/commit/2465107a242b1a77ec16f6cbd16c6c4e85ffc1e5), [`2465107`](https://github.com/haverstack/core/commit/2465107a242b1a77ec16f6cbd16c6c4e85ffc1e5)]:
  - @haverstack/core@0.36.0

## 0.4.0

### Minor Changes

- Released for a breaking change in `@haverstack/core`.

### Patch Changes

- Updated dependencies [[`227ddf8`](https://github.com/haverstack/core/commit/227ddf8eede5c1ea5a88f2336f33c8bde6280070), [`4368d1b`](https://github.com/haverstack/core/commit/4368d1bd990721f91e5e70f833417aded60ecd8b), [`1d3d8b9`](https://github.com/haverstack/core/commit/1d3d8b998bd52ac0f0b88707a7116007779a226a), [`ea2b328`](https://github.com/haverstack/core/commit/ea2b328b59ae4e4f2fcb8743b0359e49b7a79deb), [`70075a2`](https://github.com/haverstack/core/commit/70075a268a8fbae909dfb5fe9dae04a53f13f2e9), [`b4b21db`](https://github.com/haverstack/core/commit/b4b21dbc208937817f26602fd53751601e6d43a0), [`93111dc`](https://github.com/haverstack/core/commit/93111dcb4989a35c5c5160eb46b418fd829ed50e)]:
  - @haverstack/core@0.35.0

## 0.3.0

### Minor Changes

- [#296](https://github.com/haverstack/core/pull/296) [`5feb1cd`](https://github.com/haverstack/core/commit/5feb1cd1a58726df6e9ff113daab57c27935d843) Thanks [@cuibonobo](https://github.com/cuibonobo)! - Give the change journal its own association shape, and write down the erasure boundary around a purge.

  A journal entry's three association lists become one tagged list, `associations: AssociationChange[]`, with `add`, `repoint` and `remove` arms. Each element carries the state it displaced, so an inverse is read off one element instead of joined across two lists against a key that was never identity. A removal now keeps the annotation it carried, which makes it as undoable as a re-point. The change feed keeps its two flat lists unchanged; they are flattened out of the entry's list, so the two halves cannot disagree. The `journal` table replaces its three `associations_*` columns with one, and `GET /records/:id/journal` carries the new field.

  An association list holding one identity twice is now refused with `StackValidationError` rather than collapsed, and every adapter keys associations by identity.

  `delete()` returns `{ referencedFileIds }`: a purge deletes no bytes, but it destroys the only rows naming the files the record referenced, so it reports them and the caller makes the intentional `deleteAttachment()` call. A hard delete over the wire answers `200` with the record it destroyed rather than `204`, which is where a client reads that report.

  `getJournal()` throws `StackNotFoundError` for a record that does not exist or was purged, instead of answering an empty log — an empty log means "nothing changed" unconditionally.

### Patch Changes

- Updated dependencies [[`5feb1cd`](https://github.com/haverstack/core/commit/5feb1cd1a58726df6e9ff113daab57c27935d843)]:
  - @haverstack/core@0.34.0

## 0.2.0

### Minor Changes

- [#294](https://github.com/haverstack/core/pull/294) [`d9a088a`](https://github.com/haverstack/core/commit/d9a088ac710bfc4cb2310e9a38914dc28f70b325) Thanks [@cuibonobo](https://github.com/cuibonobo)! - Cover the change journal in the record adapter suite

  `getJournal()` is required of every adapter — an empty log has to mean "nothing
  changed" unconditionally, because the alternative spelling available to an
  adapter with no journal is exactly that answer. The suite that calls itself the
  runnable form of the adapter contract checked version snapshots and associations
  and said nothing about the tier beside them, so an adapter could pass every test
  here while returning `[]` from `getJournal()` forever.

  Nine tests close that: the method's presence, `seq` dense from 1 and counted per
  record, the `version`/`typeId`/`parentId` stamp coming off the row the write
  produced rather than the caller, a version that stands still across an
  association change, `associationsReplaced` surviving the round trip,
  `previousParentId` telling "did not move" apart from "moved off the root", the
  `sinceSeq`/`limit` window, a failed mutation leaving no entry, and a hard delete
  destroying the log rather than leaving it for the next record at that id.
