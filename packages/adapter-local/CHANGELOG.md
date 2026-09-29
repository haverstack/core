# @haverstack/adapter-local

## 0.38.0

### Minor Changes

- Released for a breaking change in `@haverstack/blob-adapter-disk`, `@haverstack/core`, `@haverstack/record-adapter-sqlite`.

### Patch Changes

- Updated dependencies [[`a431168`](https://github.com/haverstack/core/commit/a43116869768b7f6e7f7a7bb9712d6821d831498), [`4a3bc8e`](https://github.com/haverstack/core/commit/4a3bc8e86f69296ce18413e2225e6f35557a3b1c)]:
  - @haverstack/blob-adapter-disk@0.37.0
  - @haverstack/record-adapter-sqlite@0.31.0
  - @haverstack/core@0.39.0

## 0.37.0

### Minor Changes

- [#328](https://github.com/haverstack/core/pull/328) [`ce4ac6d`](https://github.com/haverstack/core/commit/ce4ac6da617549745aee4b7ccc1aacad3d8007b7) Thanks [@cuibonobo](https://github.com/cuibonobo)! - "Who did this, and through which principal" is one `Actor` type — `{ subjectId, principalId? }` — everywhere it appears. `StackRecord` and `RecordVersion` carry `createdBy: Actor` (replacing `entityId` + `principalId`) and `updatedBy: Actor` (replacing `updatedBy` + `updatedVia`), on the wire as in memory. `ChangeActor` is `Actor & { appId? }`, `TokenSession` is an `Actor` with `principalId` always set, and `ActorOptions` is `{ actor?: Actor }`. `RecordFilter.createdBy` and `ChangeFilter.createdBy` replace the author filters (query params `createdBySubject` / `createdByPrincipal`). `Stack.asActor(actor)` replaces `forSession()` and `asEntity()`'s `onBehalfOf` option, and `StackTokenStore.createToken()` takes an `Actor`. The SQLite `versions` table gains a `principal_id` column so a snapshot keeps its author's principal.

- [#347](https://github.com/haverstack/core/pull/347) [`cd467d9`](https://github.com/haverstack/core/commit/cd467d90cab977001bc4b097f9291c6c49fae226) Thanks [@cuibonobo](https://github.com/cuibonobo)! - Align the adapter vocabulary with the client's.
  - The version precondition is `ifVersion` on both sides of the `Stack`/adapter boundary: `StackRecordAdapter` methods take the root export `IfVersionOptions` (`{ ifVersion?: number }`), and `ExpectedVersionOptions` is removed. `StackVersionConflictError.expectedVersion` and the wire payload are unchanged.
  - Capabilities have one name: `AdapterCapabilities` (from `@haverstack/core/adapter`) and its root alias `StackFeatures` are replaced by `StackCapabilities`, exported from the root, and `Stack.features`, `ScopedStack.features` and `StackClient.features` are renamed `capabilities`.
  - `StackBlobAdapter` methods are renamed `putBlob`, `getBlob`, `deleteBlob` and `listBlobs`, and `BlobFileInfo` is renamed `BlobInfo`, so "attachment" names only the record-backed `Stack` operation. `putAttachmentWithMetadata` keeps its name. The blob conformance suite's `listFiles` option is renamed `listBlobs`.

- [#351](https://github.com/haverstack/core/pull/351) [`2f12d0a`](https://github.com/haverstack/core/commit/2f12d0a6ed6adab7d04cf858f566bad18826cdc9) Thanks [@cuibonobo](https://github.com/cuibonobo)! - Final consistency pass over the public API.
  - `collectAttachmentGarbage()` reports `deletedFileIds: FileId[]`, matching `DeleteResult.referencedFileIds`, instead of `deleted: string[]`.
  - `RecordChange.associationsAdded`/`associationsRemoved` (and their wire counterparts) are typed `DataAssociation[]`, matching what the feed has always carried: permission moves are announced by the `reshare` op, never in these lists.
  - `CreateRecordOptions.id`/`parentId` and `RecordChangeSet.parentId` are typed `RecordId`.
  - The stack owner is named `ownerEntityId` wherever an adapter is created, matching the `ownerEntityId` it then exposes: `LocalAdapter.initialize()`/`openOrInitialize()`, `NativeSQLiteRecordAdapter.initialize()` and `DoSQLiteRecordAdapter.openOrInitialize()` take `ownerEntityId` instead of `entityId`, and `APIAdapter.open()` takes `expectedOwnerEntityId` instead of `expectedOwner`.
  - `DoSQLiteRecordAdapter.create()` is `openOrInitialize()`, the name `LocalAdapter` uses for the same reattach-or-create behavior.
  - Adapter option types are named `<Class><Method>Options`: `LocalAdapterInitializeOptions`, `LocalAdapterOpenOptions`, `LocalAdapterOpenOrInitializeOptions`, `NativeSQLiteRecordAdapterInitializeOptions`, `NativeSQLiteRecordAdapterOpenOptions`, `DoSQLiteRecordAdapterOpenOrInitializeOptions` and `NativeTokenStoreOpenOptions`.

- [#351](https://github.com/haverstack/core/pull/351) [`546e28c`](https://github.com/haverstack/core/commit/546e28cf1d78f3a088d7962272a7d3bd70a9ff62) Thanks [@cuibonobo](https://github.com/cuibonobo)! - Follow-ups to the API consistency pass.
  - The `Stack` prefix is reserved for the `StackError` taxonomy. The local errors outside it are renamed: `StackClosedError` → `UseAfterCloseError` and `StackRelayScopeError` → `RelayScopeError`.
  - Every `@haverstack/core` export has exactly one entry point. `StackAdapter` moves from the root to `@haverstack/core/adapter`, beside its record and blob halves; `TokenSession` moves from the root to `@haverstack/core/wire`, beside `StackTokenStore` and `TokenInfo`; `ContentFilterReach` and `MissingCapability` are no longer exported from `@haverstack/core/adapter`, only the root; and `@haverstack/core/wire` no longer re-exports the root's errors (`StackValidationError`, and `StackQueryError` under its new name `StackBadRequestError`).
  - `LocalAdapter.openOrInitialize()` throws `LocalAdapterOwnerMismatchError` (with `expectedOwnerEntityId`, `actualOwnerEntityId` and `path`) on an owner mismatch, and releases the database lock before throwing. `APIAdapterOwnerMismatchError`'s `expectedOwner`/`actualOwner` fields are now `expectedOwnerEntityId`/`actualOwnerEntityId`, matching.
  - `DiskBlobAdapter` takes an options object, `new DiskBlobAdapter({ dir })`, like `S3BlobAdapter`.

- [#350](https://github.com/haverstack/core/pull/350) [`987d533`](https://github.com/haverstack/core/commit/987d53303099fc9478a5f6708651c8a898c3008d) Thanks [@cuibonobo](https://github.com/cuibonobo)! - Make every `ChangeOp` a verb and spell permanent deletion one way. The record-level ACL op `'permissions'` is now `'reshare'`. Permanent deletion is `purge` everywhere: `delete(id, { purge: true })` (was `{ hard: true }`), `deleteRecord(id, { purge: true })` on every adapter, `DELETE /records/:id?purge=true` on the wire (was `?hard=true`), and the op `'purge'` (was `'hard-delete'`), matching the existing `'purged'` kind.

### Patch Changes

- Updated dependencies [[`ce4ac6d`](https://github.com/haverstack/core/commit/ce4ac6da617549745aee4b7ccc1aacad3d8007b7), [`cd467d9`](https://github.com/haverstack/core/commit/cd467d90cab977001bc4b097f9291c6c49fae226), [`2f12d0a`](https://github.com/haverstack/core/commit/2f12d0a6ed6adab7d04cf858f566bad18826cdc9), [`546e28c`](https://github.com/haverstack/core/commit/546e28cf1d78f3a088d7962272a7d3bd70a9ff62), [`147bbdf`](https://github.com/haverstack/core/commit/147bbdf8e8ce50c5865875b0c56e410fee01994f), [`83ded9c`](https://github.com/haverstack/core/commit/83ded9c2274d5e1ca29e8de4fa714a9da5eff2d1), [`e36923c`](https://github.com/haverstack/core/commit/e36923cf3799f8d3a13176c23b293f4967e4928b), [`987d533`](https://github.com/haverstack/core/commit/987d53303099fc9478a5f6708651c8a898c3008d), [`fa9e4b8`](https://github.com/haverstack/core/commit/fa9e4b8be57a22b63bb63479f89644ea52bf038b), [`ad14212`](https://github.com/haverstack/core/commit/ad142122b11c74aee921e61441691c1914425ed2), [`4caed17`](https://github.com/haverstack/core/commit/4caed174a242fac5698018a63762a53f9b642ff6), [`e4c8628`](https://github.com/haverstack/core/commit/e4c862860111a090fe1b08cd63e2da71e62f1e56), [`40b3757`](https://github.com/haverstack/core/commit/40b3757a93a2dd1a68a7fbb40273efe3503719a6), [`e3057db`](https://github.com/haverstack/core/commit/e3057db5af528136270b3c418bb0021d3727d5a5), [`1b0e0c7`](https://github.com/haverstack/core/commit/1b0e0c73e386cd9adc178a8b56a72944bd334f46), [`7cffb1d`](https://github.com/haverstack/core/commit/7cffb1dc8e33993082aaa83599ba2e031a1c5cde)]:
  - @haverstack/core@0.38.0
  - @haverstack/record-adapter-sqlite@0.30.0
  - @haverstack/blob-adapter-disk@0.36.0

## 0.36.0

### Minor Changes

- Released for a breaking change in `@haverstack/blob-adapter-disk`, `@haverstack/core`, `@haverstack/record-adapter-sqlite`.

### Patch Changes

- Updated dependencies [[`11444f6`](https://github.com/haverstack/core/commit/11444f694cfa6b24fbe926cf7420d3523a3fa95f)]:
  - @haverstack/core@0.37.0
  - @haverstack/blob-adapter-disk@0.35.0
  - @haverstack/record-adapter-sqlite@0.29.0

## 0.35.1

### Patch Changes

- [#315](https://github.com/haverstack/core/pull/315) [`1f6dc32`](https://github.com/haverstack/core/commit/1f6dc32b87c1ae067e7bfe7a8ff76eb6434cad30) Thanks [@cuibonobo](https://github.com/cuibonobo)! - Carry a write's journal entry through `LocalAdapter`

  `createRecord()`, `associate()` and `dissociate()` took the options object
  the record adapter beneath them expects and dropped it on the way through,
  so `opts.journal` never reached storage. Every other mutating method
  forwarded it.

  A stack on this adapter therefore recorded no journal entry for a create or
  for either association verb — the two the tier exists for. `getJournal()`
  answered an empty log, which means _nothing changed_ unconditionally, so a
  caller reconstructing an association's history was told there was none
  rather than being refused. An `attachmentRecordId` a re-point overwrote was
  retained nowhere, which is the one thing no other tier keeps.

## 0.35.0

### Minor Changes

- Released for a breaking change in `@haverstack/blob-adapter-disk`, `@haverstack/core`, `@haverstack/record-adapter-sqlite`.

### Patch Changes

- Updated dependencies [[`2465107`](https://github.com/haverstack/core/commit/2465107a242b1a77ec16f6cbd16c6c4e85ffc1e5), [`2465107`](https://github.com/haverstack/core/commit/2465107a242b1a77ec16f6cbd16c6c4e85ffc1e5)]:
  - @haverstack/blob-adapter-disk@0.34.0
  - @haverstack/record-adapter-sqlite@0.28.0
  - @haverstack/core@0.36.0

## 0.34.0

### Minor Changes

- Released for a breaking change in `@haverstack/blob-adapter-disk`, `@haverstack/core`, `@haverstack/record-adapter-sqlite`.

### Patch Changes

- [#311](https://github.com/haverstack/core/pull/311) [`4368d1b`](https://github.com/haverstack/core/commit/4368d1bd990721f91e5e70f833417aded60ecd8b) Thanks [@cuibonobo](https://github.com/cuibonobo)! - Comments only: give each rule one home and link to it from the sites that depend on it, rather than re-arguing it at each. No behavior change.
- Updated dependencies [[`227ddf8`](https://github.com/haverstack/core/commit/227ddf8eede5c1ea5a88f2336f33c8bde6280070), [`4368d1b`](https://github.com/haverstack/core/commit/4368d1bd990721f91e5e70f833417aded60ecd8b), [`1d3d8b9`](https://github.com/haverstack/core/commit/1d3d8b998bd52ac0f0b88707a7116007779a226a), [`ea2b328`](https://github.com/haverstack/core/commit/ea2b328b59ae4e4f2fcb8743b0359e49b7a79deb), [`70075a2`](https://github.com/haverstack/core/commit/70075a268a8fbae909dfb5fe9dae04a53f13f2e9), [`b4b21db`](https://github.com/haverstack/core/commit/b4b21dbc208937817f26602fd53751601e6d43a0), [`93111dc`](https://github.com/haverstack/core/commit/93111dcb4989a35c5c5160eb46b418fd829ed50e)]:
  - @haverstack/core@0.35.0
  - @haverstack/record-adapter-sqlite@0.27.0
  - @haverstack/blob-adapter-disk@0.33.0

## 0.33.0

### Minor Changes

- Released for a breaking change in `@haverstack/blob-adapter-disk`, `@haverstack/core`, `@haverstack/record-adapter-sqlite`.

### Patch Changes

- Updated dependencies [[`5feb1cd`](https://github.com/haverstack/core/commit/5feb1cd1a58726df6e9ff113daab57c27935d843)]:
  - @haverstack/blob-adapter-disk@0.32.0
  - @haverstack/core@0.34.0
  - @haverstack/record-adapter-sqlite@0.26.0

## 0.32.0

### Minor Changes

- [#287](https://github.com/haverstack/core/pull/287) [`a0163e7`](https://github.com/haverstack/core/commit/a0163e73126e487579502cd36a0e1be9e27ba30d) Thanks [@cuibonobo](https://github.com/cuibonobo)! - Associations no longer bump `version`, snapshot, or restore

  **`associate()`/`dissociate()` — and a change set whose only key is
  `associations` — no longer bump a Record's `version`, touch `updatedAt`, or
  write a version snapshot.** Content mutation is destructive the instant it
  lands, which is what version history exists to make recoverable.
  Associations aren't: the inverse operation is the same shape as the
  forward one and reconstructs the prior state exactly (an
  attachment-annotation overwrite is the one minor exception), so they never
  needed the rollback machinery.

  ```ts
  const before = await stack.get(record.id);
  await stack.associate(record.id, { kind: 'tag', label: 'starred' });
  const after = await stack.get(record.id);
  after.version === before.version; // true — this used to bump
  ```

  They still appear on the change feed (`docs/spec/events.md`) as
  `associate`/`dissociate` ops, so a subscriber still hears about them — the
  event just carries the record's unchanged `version`/`updatedAt`, and its
  `actor` now travels as an explicit fact about the call rather than being
  read off a record field these calls no longer stamp.

  **`associate()`/`dissociate()` drop `ifVersion` entirely — this is a
  breaking signature change.** A set-add/remove composes correctly
  regardless of write order, so there was never a race for the precondition
  to guard, and offering one that could no longer trigger a bump would just
  be silently useless. `mutate()` follows the same line, read off the keys a
  change set names: one whose only key is `associations` carries no
  precondition either, so an `ifVersion` passed alongside it is not checked.
  A change set that names any other aspect is unaffected — `ifVersion` still
  fences the whole call, same as ever, including where that aspect restates
  what the record already holds and the call writes nothing.

  **`restoreVersion()` never restores associations, for any Record type —
  this generalizes what used to be a `_group`-only carve-out.** A `_group`'s
  roster already didn't roll back, on the grounds that a roster is authority
  rather than data; that reasoning turned out to apply to every Record's
  associations, not just a group's. `RecordVersion` drops the `associations`
  field entirely — no snapshot has ever captured one since associate()/
  dissociate() stopped bumping, so there was nothing left for a restore to
  read one back from. `restoreAssociations` is gone from every
  `restoreVersion()` options type; it's unconditional now, and needs no more
  flag than `permissions`, which restore has never touched.

  **Adapter contract:** `StackRecordAdapter.associate()`/`dissociate()` drop
  their `opts` parameter — no `ifVersion`, snapshot, or actor stamping,
  since none of it applies to a write that never bumps. `mutateRecord()`
  gains `opts.bumpsVersion` (computed by `Stack`, not inferred by the
  adapter) so a change set naming only `associations` can skip the
  records-table update and snapshot entirely. `restoreVersion()` drops
  `restoreAssociations` — an adapter no longer receives an association list
  to restore from in the first place.

  **Wire protocol:** the association endpoints (`POST /records/:id/associations`,
  `POST /records/:id/associations/delete`) no longer accept `If-Match` — same
  reasoning as the local `ifVersion` drop. `WireVersion` drops
  `associations`. A `PATCH /records/:id` change set naming only
  `associations` no longer bumps `version` either, matching the standalone
  endpoints, and an `If-Match` sent with such a body is not checked.

- [#289](https://github.com/haverstack/core/pull/289) [`b34de0d`](https://github.com/haverstack/core/commit/b34de0d5aceb933aff91b82714c47ad96e9f00b2) Thanks [@cuibonobo](https://github.com/cuibonobo)! - A durable change journal, beside version history

  **Every write that emits a change event now also appends one entry to the
  record's journal** — a second durable tier holding what the change moved,
  who moved it, and the association deltas nothing else retains.

  A snapshot answers _what could be put back_; a journal entry answers _what
  happened_. Content needs only the first, because its prior state is in the
  snapshot. Associations need the second, because theirs is nowhere: the
  inverse of an `associate()` is a `dissociate()` of the same shape, but
  deriving _which_ inverse takes the prior state, and until now that state
  reached the change feed and nowhere else.

  ```ts
  await stack.associate(note.id, { kind: 'tag', label: 'draft' });
  await stack.dissociate(note.id, { kind: 'tag', label: 'draft' });

  // Days later, in a process that was never subscribed:
  for (const entry of await stack.getJournal(note.id)) {
    entry.ops; // ['associate'] / ['dissociate']
    entry.associationsAdded; // the association, as it stood
  }
  ```

  `associationsReplaced` is the one field with no counterpart on the feed:
  re-pointing an `attachmentRecordId` overwrites the old value, and a frame
  reports only what is current. The journal keeps what it replaced, which is
  what makes a re-point undoable rather than merely observable.

  **`stack.getJournal(recordId, { sinceSeq?, limit? })` is gated on the
  mutate surface, exactly as `getVersions()` is.** A log of who changed what,
  gated on current read access, would make a record's past as reachable as
  its present. A plain reader gets `StackPermissionError`. `sinceSeq` and
  `limit` are each held to a non-negative integer at the surface, before any
  adapter sees them: left unchecked a negative `limit` diverged rather than
  failing, dropping the newest entry on an in-memory log and lifting the
  ceiling entirely on SQLite. Omitting `limit` still reads the whole log —
  no ceiling is imposed, because the caller reconstructing an association's
  full history is exactly who a silent truncation would betray.

  `getJournal()` is declared on the `StackClient` interface alongside
  `getVersions()`/`restoreVersion()`. Anyone implementing `StackClient`
  outside this package must add it.

  **A hard delete destroys the journal, exactly as it destroys version
  history** — so the journal never records a purge.

  **Adapter contract:** every mutating `StackRecordAdapter` method takes
  `opts.journal`, and `associate()`/`dissociate()` take an options object for
  the first time since they stopped bumping. Adapters append the entry inside
  the same write as the mutation, stamping `seq`, `at`, `version`, `typeId`
  and `parentId` from the row they just wrote — `Stack` supplies only the
  half a record cannot report afterwards. `seq` is allocated by the adapter
  from the log's own maximum, so unlike a snapshot's caller-computed version
  number there is no collision to heal. `getJournal()` is **required** on
  the interface, not optional: an adapter with no journal to read refuses
  the call rather than declining to have the method, so an empty log always
  means "nothing changed" and never "this stack does not remember".

  **Also fixes `createRecord` applying non-atomically** in the SQLite
  adapters. It writes five statements — the record row, associations, the
  full-text index, the content index and now a journal entry — and was the
  only mutating method in the shared logic not wrapped in a transaction. A
  failure partway left a records row behind while raising to the caller, so
  a create that reported failure had half-succeeded, its retry failed on the
  primary key, and the surviving row was invisible to `filter.search` and
  mis-ordered by `sort.contentField` until something wrote it again.

  The wire surface lands in this same release: `GET /records/:id/journal`
  carries the read, so `APIAdapter.getJournal()` answers it like any other
  adapter and refuses nothing. That is what lets the method sit on
  `StackClient` as a requirement rather than a capability — there is no
  adapter left that cannot answer it.

### Patch Changes

- Updated dependencies [[`b164b5f`](https://github.com/haverstack/core/commit/b164b5f553967ae6190b5bd60ff42ad128724494), [`a0163e7`](https://github.com/haverstack/core/commit/a0163e73126e487579502cd36a0e1be9e27ba30d), [`dc6f3b2`](https://github.com/haverstack/core/commit/dc6f3b28e42f4ab6ffd5c14ef9465155c8f1eb14), [`b34de0d`](https://github.com/haverstack/core/commit/b34de0d5aceb933aff91b82714c47ad96e9f00b2)]:
  - @haverstack/core@0.33.0
  - @haverstack/record-adapter-sqlite@0.25.0
  - @haverstack/blob-adapter-disk@0.31.0

## 0.31.0

### Minor Changes

- Released for a breaking change in `@haverstack/blob-adapter-disk`, `@haverstack/core`, `@haverstack/record-adapter-sqlite`.

### Patch Changes

- Updated dependencies [[`8e42a7f`](https://github.com/haverstack/core/commit/8e42a7fc0bf13be2b2697f10efb21a88c95752fc)]:
  - @haverstack/core@0.32.0
  - @haverstack/record-adapter-sqlite@0.24.0
  - @haverstack/blob-adapter-disk@0.30.0

## 0.30.0

### Minor Changes

- Released for a breaking change in `@haverstack/blob-adapter-disk`, `@haverstack/core`, `@haverstack/record-adapter-sqlite`.

### Patch Changes

- Updated dependencies [[`ac30074`](https://github.com/haverstack/core/commit/ac30074752738ef814cbe34556a9586f6b86d209), [`14a63db`](https://github.com/haverstack/core/commit/14a63db7ba51ae20bcd8e27ff7c40da5afb81683), [`0052b6b`](https://github.com/haverstack/core/commit/0052b6b14a32e9ada2faa4454999c33d2847c61a)]:
  - @haverstack/blob-adapter-disk@0.29.0
  - @haverstack/record-adapter-sqlite@0.23.0
  - @haverstack/core@0.31.0

## 0.29.0

### Minor Changes

- Released for a breaking change in `@haverstack/blob-adapter-disk`, `@haverstack/core`, `@haverstack/record-adapter-sqlite`.

### Patch Changes

- Updated dependencies [[`1010033`](https://github.com/haverstack/core/commit/101003350a4bb8e590c1942339fc405bef31aeb8), [`974f10a`](https://github.com/haverstack/core/commit/974f10aec3ebc1ebf47041152da105dbbecfd1a2), [`e1420b0`](https://github.com/haverstack/core/commit/e1420b0e27a9027d4d00e61e47874e8b1685cff7), [`1f3adb6`](https://github.com/haverstack/core/commit/1f3adb61926bc6d511fafc08fcd64a469ec884aa), [`fca0f79`](https://github.com/haverstack/core/commit/fca0f79196c2703d4fea168e983d519249012719)]:
  - @haverstack/blob-adapter-disk@0.28.0
  - @haverstack/record-adapter-sqlite@0.22.0
  - @haverstack/core@0.30.0

## 0.28.0

### Minor Changes

- [#269](https://github.com/haverstack/core/pull/269) [`06b791c`](https://github.com/haverstack/core/commit/06b791cb4c5e15dd06442ab2ebfabb82cd014745) Thanks [@cuibonobo](https://github.com/cuibonobo)! - Move a record's aspects in one call, one version

  **`mutate(id, changes, opts)` replaces `update()`, `setPermissions()`, `setUnlisted()` and
  `setParent()`.** It takes a change set naming any combination of `contentPatch`, `parentId`,
  `permissions`, `associations` and `unlisted`, applies it as one atomic write, and produces
  exactly one version carrying one snapshot.

  ```ts
  await stack.mutate(note.id, {
    contentPatch: { title: 'Q3 plan' },
    parentId: folder.id,
    unlisted: false,
  });
  ```

  Each aspect used to have its own verb, so "save and move", "save and share" and "save and
  publish" each cost a version apiece and three round trips — and could not be fenced by one
  `ifVersion`, since the second call had to be pinned against a version only the first call's
  response could supply.

  **Keys are read for presence, not truthiness.** `unlisted: false` and `parentId: null` name
  aspects and are applied; an omitted key is untouched. A change set naming no key at all is
  `StackQueryError` (wire: 400) — it addresses nothing, so there is nothing it could have
  failed to satisfy. A change set already satisfied in every key writes nothing and returns
  the record unchanged.

  **`patchContent(id, patch, opts)` is the content-only spelling**, and the name the adapter
  primitive already used. `update()` is gone: it promised a symmetry with `create()` that a
  merge patch does not have.

  ## `contentPatch` is the one key that merges

  Every other key replaces the aspect it names. Content stays a patch for three concrete
  reasons: `limits.contentBytes` bounds what travels, so a whole-document write would charge a
  one-field edit against the full ceiling; two apps editing different top-level fields both
  survive a patch and clobber one another under replacement; and content read through
  `presentAt: 'latest'` cannot be written back wholesale at all, since a write validates
  against the record's _own stored_ type and a read-modify-write across a pending migration
  would submit migrated content to the schema it was migrated away from.

  The key is named for its semantic so that asymmetry is visible at the call site rather than
  resident in prose.

  ## Authority resolves per key, against the record as it stands

  The aspects do not share a gate — content is reachable by a write-holder or an `update-*`
  grantee, `permissions` and `unlisted` only by the owner or the record's own creator. So a
  change set resolves each key on its own and lands exactly where the same caller would have
  landed one key at a time: **a requester who may perform every key may perform the set, and a
  requester who may not perform one of them may not perform any of it.**

  Every gate reads the record's **pre-change** state. A widened `permissions` in a change set
  never satisfies the read check on a `parentId` named in the same call, and a `_group` roster
  never satisfies the admin check that same call must pass — either would be a one-call
  escalation out of a gate the single-key spelling enforces. A refused key refuses the whole
  call: nothing is partially applied and no key is silently dropped.

  ## `associate()` / `dissociate()` stay their own verbs

  They amend the association set where the `associations` key replaces it. Two apps tagging
  one record both succeed through the methods and race through the key, so the delta spelling
  is kept for the operation that most needs it rather than folded into a declarative envelope,
  where "add this one" is not a thing that can be said.

  ## Change events name every aspect that moved

  `RecordChange.op` becomes **`ops: ChangeOp[]`**, derived by diffing the record against its
  prior state rather than read off the request — so naming an aspect without moving it is
  never reported as moving it. The `update` op is renamed **`patch`**. `kind` resolves to the
  most conservative entry: a change set carrying `unlist` is `deleted` whatever else it
  carries, because a subscriber holding the record still has to drop it. Every op outside
  `mutate()`'s reach (`create`, `delete`, `undelete`, `hard-delete`, `migrate`, `restore`) is
  still emitted alone, so a multi-entry `ops` is always a change set.

  ## Wire format

  `PATCH /records/:id` now takes the change-set envelope, and `PUT .../parent`,
  `PUT .../permissions` and `PUT .../unlisted` are gone — one `If-Match` fences a whole
  multi-aspect edit. `GET /records/:id/permissions` stays. An unrecognized top-level key is
  **400** and a key the type does not declare inside `contentPatch` is **422**, the same split
  every other write endpoint makes. `changesFromWireBody()` in `@haverstack/core/wire` applies
  this for servers built on core.

  The envelope also retires a wart: `contentPatch.parentId` and the native `parentId` are now
  unambiguous by construction, rather than by a rule the spec had to state twice.

  ## Adapters

  The four single-aspect adapter methods (`patchContent`, `setPermissions`, `setUnlisted`,
  `setParent`) collapse into one **`mutateRecord(id, changes, opts)`**. This shrinks the
  contract rather than growing it: in `sqlite-shared` those four were already the same
  `UPDATE records SET <col>, version = version + 1, updated_at = ?, ...` with one column
  swapped, and they are now one statement with a variable SET list. `Stack` narrows a change
  set to the aspects that actually moved before it reaches an adapter, so every key an adapter
  receives is one it must write — which is what keeps a restated `unlisted: true` from
  dragging `unlistedAt` forward with no op reporting it.

  ## Conformance fixtures

  The three fixture groups named for retired endpoints are renamed for the change-set keys
  they now exercise: `setPermissionsFixtures` → **`permissionsChangeFixtures`**,
  `setUnlistedFixtures` → **`unlistedChangeFixtures`**, `setParentFixtures` →
  **`parentChangeFixtures`**. `patchContentFixtures` keeps its name, since `patchContent()`
  does.

  ## Also

  **Fixed: the content merge was documented as RFC 7396, which recurses, but is one level
  deep.** `applyMergePatch` iterates top-level keys and replaces each value whole, so a nested
  object in a patch replaces rather than merges. The spec now states the top-level rule and
  drops the RFC citation; an app author trusting the reference would have expected a nested
  patch to preserve sibling keys and silently lost them. Behavior is unchanged — only the
  claim about it.

- [#271](https://github.com/haverstack/core/pull/271) [`c8e70ab`](https://github.com/haverstack/core/commit/c8e70ab0576336d1f58bfd8054406e7f445ea2b4) Thanks [@cuibonobo](https://github.com/cuibonobo)! - A group keeps at least one admin

  **"A `_group` Record's roster carries at least one `admin`" becomes an invariant of the
  Record rather than a convenience at create time.** `stampGroupAdmin()` already made the
  creator the first admin, and `identity.md` already promised that "no Group is ever
  management-orphaned" — but nothing re-asserted it on a subsequent write, so a roster could
  be emptied and the Group left manageable by the stack owner alone.

  Any write that would leave the roster with no `admin` is now refused with
  `StackConflictError` (wire: 409), whether it arrives through a change set's `associations`,
  which replaces the roster wholesale, or through `dissociate()`, which removes one entry.

  ```ts
  // Refused: nothing would be left to manage the group.
  await stack.mutate(group.id, { associations: [] });

  // Fine: an admin may step down while another remains.
  await stack.dissociate(group.id, { kind: 'relationship', label: 'admin', target: me });
  ```

  **The check reads the roster the write would produce, not the one it started from.** That is
  what makes it precise without special cases: an `admin` may remove themselves while another
  remains, and may not remove the last one, and neither case needs to name who is being
  removed. It is also the one place a change-set check reads the post-state — the rule is
  about what a write leaves behind rather than about what the caller named.

  **The stack owner does not bypass it.** They can already manage any Group, so the rule costs
  them nothing they wanted, and a bypass would mean nothing downstream could rely on the
  invariant. It therefore lives in `Stack` alongside the other integrity constraints rather
  than in `ScopedStack`'s group gate: who may write a `_group` is a permission question, and
  this is not one.

  Taken with the restore rule below, the three together close the invariant by construction:
  every `_group` holds an admin from its first version, no write takes a roster to zero, and no
  restore moves a roster at all. An admin-less roster is not a state the API can reach. Because
  the check reads the post-state it would still behave correctly on one manufactured by a
  direct adapter write — permitting a write that names an incoming admin, refusing one that
  does not — but that falls out of the framing rather than being a repair path the rules
  promise.

  What this does **not** promise is that an `admin` is _reachable_: an admin who loses their
  key strands a Group as thoroughly as an empty roster would. The invariant closes an
  accidental write, not the general problem of custody.

  ## A restore does not roll back a Group's roster

  On a `_group` Record, `content` and `parentId` roll back as they do anywhere, and the
  Record's **`associations` are left exactly as they stand** — the snapshot's are not put back,
  and the current ones are not taken away.

  This is the stance restore already takes on `permissions`, applied to the whole roster on the
  grounds that a roster is authority rather than data. A Group's `member` and `admin` entries
  are what group ACLs and group-targeted grants resolve against, so rolling either half back
  silently re-grants access as a side effect of a verb the caller asked for its content:
  management to an `admin` who had been deliberately removed, reach to a `member` who had been
  dropped. Recovering a former roster is a deliberate `associate()`, which is the point.

  It is also what lets the invariant hold here without a check. A restore cannot move a roster,
  so it cannot be the write that empties one, and no version of a `_group` is unrestorable on
  that ground.

  ## Adapters

  `StackRecordAdapter.restoreVersion()` gains an optional **`restoreAssociations`** in `opts`.
  `false` rolls back everything but the associations, leaving the record's current list where
  it stands; absent or `true` applies the snapshot's, as before. An adapter needs no knowledge
  of `_group` or of roster labels, which keeps the rule in core where the record's meaning is
  known. `Stack.restoreVersion()` is its only caller.

  No association list travels to an adapter, which is deliberate: there is no list resolved
  above the adapter and written below it, so nothing a restore writes can disagree with what
  the record already holds, and no read-then-write window exists for a concurrent roster change
  to be undone through.

  `@haverstack/adapter-api` does not send it. The wire protocol has no field for it and needs
  none: the server runs the same `Stack` logic over its own adapter and reaches the same answer
  from the same record. A wire field would only let a client _propose_ that answer.

  `ScopedStack.restoreVersion()`'s reference-creation gate skips a `_group` Record's
  associations entirely — a restore does not move the roster, so it introduces no association
  to gate, on the same reasoning that leaves a `parentId` the restore would not change
  un-regated.

### Patch Changes

- Updated dependencies [[`06b791c`](https://github.com/haverstack/core/commit/06b791cb4c5e15dd06442ab2ebfabb82cd014745), [`c8e70ab`](https://github.com/haverstack/core/commit/c8e70ab0576336d1f58bfd8054406e7f445ea2b4), [`64cda3b`](https://github.com/haverstack/core/commit/64cda3bb5b7b21ec9277695fea8fd78516d0e6ca)]:
  - @haverstack/core@0.29.0
  - @haverstack/record-adapter-sqlite@0.21.0
  - @haverstack/blob-adapter-disk@0.27.0

## 0.27.0

### Minor Changes

- [#263](https://github.com/haverstack/core/pull/263) [`12e1a4b`](https://github.com/haverstack/core/commit/12e1a4bf9db1086a6b546859171f3a7bf72db322) Thanks [@cuibonobo](https://github.com/cuibonobo)! - Add `setParent()` — records can be moved between containers after creation

  `parentId` was settable at create and nowhere else: `update()` is a content-only
  merge patch, `patchContent()` is content-only by contract, and `PATCH /records/:id`
  carries the content patch as its whole body. A record's place in the hierarchy was
  therefore fixed for life, and a `parentId` key in an `update()` patch was stored as
  a content field of that name instead.

  `setParent(id, parentId | null)` joins `setUnlisted()` and `setPermissions()` as a
  native-field verb — `null` moves a record to the root. It bumps `version`, snapshots
  the prior state, takes `ifVersion`, and travels as `PUT /records/:id/parent`.
  `StackAdapter` gains a matching `setParent()`; every bundled adapter implements it.

  Moving a record confers nothing: containment is not an access-control edge, so
  nothing is inherited from a container and nothing cascades out of one. `ScopedStack`
  gates a move as an ordinary write on the record plus read access to the destination —
  the same reference gate `create()` applies to a `parentId`. The origin is ungated,
  since naming it requires reading the record.

  An edge that would make a record its own ancestor is refused with `StackConflictError`
  (wire: 409), at both sites that add one: `setParent()`, and a `create()` supplying both
  `id` and `parentId` — a generated id names nothing, but a caller-supplied one may already
  have records pointing at it. Dangling parents stay legal. The check is read-then-write, so
  it is advisory under concurrency, the same posture as DID binding uniqueness; consumers
  that walk `parentId` should carry a visited set.

  The change feed gains a `reparent` op (kind `changed`), matched against both
  containers a move concerns so a subscription filtered on the origin learns the record
  left it. Frames carry the destination in `parentId`, as every frame carries the
  record's state at the moment of the change; a subscriber compares it to its own
  filter to tell a departure from an arrival.

### Patch Changes

- Updated dependencies [[`12e1a4b`](https://github.com/haverstack/core/commit/12e1a4bf9db1086a6b546859171f3a7bf72db322), [`e134c5a`](https://github.com/haverstack/core/commit/e134c5a8935893131361bc2da4ecff0de6ab0a5b)]:
  - @haverstack/blob-adapter-disk@0.26.0
  - @haverstack/core@0.28.0
  - @haverstack/record-adapter-sqlite@0.20.0

## 0.26.0

### Minor Changes

- Released for a breaking change in `@haverstack/blob-adapter-disk`, `@haverstack/core`, `@haverstack/record-adapter-sqlite`.

### Patch Changes

- Updated dependencies [[`e40e814`](https://github.com/haverstack/core/commit/e40e8143cda1b4a97ce930cd4e7f6d7b6b3f077f), [`5463fc1`](https://github.com/haverstack/core/commit/5463fc13e7e0f3e55c6c17bbab87ed6f4d7da7f4), [`053b53e`](https://github.com/haverstack/core/commit/053b53e016d7af16a207e940de111bcfa0eab032)]:
  - @haverstack/blob-adapter-disk@0.25.0
  - @haverstack/core@0.27.0
  - @haverstack/record-adapter-sqlite@0.19.0

## 0.25.0

### Minor Changes

- Released for a breaking change in `@haverstack/blob-adapter-disk`, `@haverstack/core`, `@haverstack/record-adapter-sqlite`.

### Patch Changes

- Updated dependencies [[`0bd803f`](https://github.com/haverstack/core/commit/0bd803f607d39faa776d5dcc1cb8bcb722d99651)]:
  - @haverstack/blob-adapter-disk@0.24.0
  - @haverstack/core@0.26.0
  - @haverstack/record-adapter-sqlite@0.18.0

## 0.24.0

### Minor Changes

- Released for a breaking change in `@haverstack/blob-adapter-disk`, `@haverstack/core`, `@haverstack/record-adapter-sqlite`.

### Patch Changes

- Updated dependencies [[`8a31b4e`](https://github.com/haverstack/core/commit/8a31b4ecb0117c86e1c5004c52f73fec9730f625), [`a9f6ebf`](https://github.com/haverstack/core/commit/a9f6ebfc63824d604cd96647aaf862c9ad362275)]:
  - @haverstack/blob-adapter-disk@0.23.0
  - @haverstack/core@0.25.0
  - @haverstack/record-adapter-sqlite@0.17.0

## 0.23.0

### Minor Changes

- [#250](https://github.com/haverstack/core/pull/250) [`0c76cb7`](https://github.com/haverstack/core/commit/0c76cb7b51f2ea407521ae1df1ff0c8e5852d53e) Thanks [@cuibonobo](https://github.com/cuibonobo)! - Add `Stack.getAttachmentRecords(fileId)`, the candidate set `firstRecordedAttachment()` orders: every `_attachment` record describing a file, family-wide by `baseId`, including soft-deleted and unlisted records, content-filtered only where the adapter declares `contentFieldQuery`, and cursor-walked to exhaustion. Sorted earliest-recorded first, so `records[0]` is the record that establishes the file's `mimeType` and the two helpers compose without the caller re-sorting. Core exported the tie-breaker but not the lookup that safely feeds it, leaving every server to re-derive a query with three ways to get it wrong.

  It lands on `Stack` and deliberately not on `StackClient`: the lookup answers a presentation question about an access decision already made, so a scoped version would impose a second, different permission check and silently drop metadata the requester is entitled to.

  `_attachment` lookups are now family-wide throughout, where they were pinned to `_attachment@1`. A record migrated to a later version of the family now establishes the file's `mimeType` (so a conflicting later upload is rejected, where it was previously accepted), is purged by `deleteAttachment()`, and is seen by `collectAttachmentGarbage()` — which previously could not discover a file whose only metadata record had been migrated.

  `StackRecordAdapter.deleteUnreferencedAttachmentRecords()` takes `metadataTypeIds: TypeId[]` in place of a single `metadataTypeId`. Core resolves the `_attachment` family to concrete typeIds before the call, so adapters still need no `baseId` concept of their own.

### Patch Changes

- Updated dependencies [[`0c76cb7`](https://github.com/haverstack/core/commit/0c76cb7b51f2ea407521ae1df1ff0c8e5852d53e)]:
  - @haverstack/blob-adapter-disk@0.22.0
  - @haverstack/core@0.24.0
  - @haverstack/record-adapter-sqlite@0.16.0

## 0.22.0

### Minor Changes

- Released for a breaking change in `@haverstack/blob-adapter-disk`, `@haverstack/core`, `@haverstack/record-adapter-sqlite`.

### Patch Changes

- Updated dependencies [[`896b516`](https://github.com/haverstack/core/commit/896b5167d68690a307cba430ded97268c83fe218), [`e4119ea`](https://github.com/haverstack/core/commit/e4119eaa03f0510aa773b31cf36e860541857517)]:
  - @haverstack/blob-adapter-disk@0.21.0
  - @haverstack/record-adapter-sqlite@0.15.0
  - @haverstack/core@0.23.0

## 0.21.0

### Minor Changes

- Released for a breaking change in `@haverstack/blob-adapter-disk`, `@haverstack/core`, `@haverstack/record-adapter-sqlite`.

### Patch Changes

- Updated dependencies [[`d945ded`](https://github.com/haverstack/core/commit/d945ded1ead75e6e3e11a6088afa72dd889c8342), [`65476bd`](https://github.com/haverstack/core/commit/65476bd3f7aa025cec0790653bcc9cdb691bfce1)]:
  - @haverstack/blob-adapter-disk@0.20.0
  - @haverstack/record-adapter-sqlite@0.14.0
  - @haverstack/core@0.22.0

## 0.20.0

### Minor Changes

- Released for a breaking change in `@haverstack/blob-adapter-disk`, `@haverstack/core`, `@haverstack/record-adapter-sqlite`.

### Patch Changes

- Updated dependencies [[`64dfb36`](https://github.com/haverstack/core/commit/64dfb3621635438c9529b4be134b60cf936fb152)]:
  - @haverstack/blob-adapter-disk@0.19.0
  - @haverstack/record-adapter-sqlite@0.13.0
  - @haverstack/core@0.21.0

## 0.19.0

### Minor Changes

- Released for a breaking change in `@haverstack/blob-adapter-disk`, `@haverstack/core`, `@haverstack/record-adapter-sqlite`.

### Patch Changes

- Updated dependencies [[`59df7e6`](https://github.com/haverstack/core/commit/59df7e657a95cdc22a6f29c73c86e5d0e2d59b80), [`59df7e6`](https://github.com/haverstack/core/commit/59df7e657a95cdc22a6f29c73c86e5d0e2d59b80), [`59df7e6`](https://github.com/haverstack/core/commit/59df7e657a95cdc22a6f29c73c86e5d0e2d59b80), [`59df7e6`](https://github.com/haverstack/core/commit/59df7e657a95cdc22a6f29c73c86e5d0e2d59b80)]:
  - @haverstack/record-adapter-sqlite@0.12.0
  - @haverstack/blob-adapter-disk@0.18.0
  - @haverstack/core@0.20.0

## 0.18.0

### Minor Changes

- Released for a breaking change in `@haverstack/blob-adapter-disk`, `@haverstack/core`, `@haverstack/record-adapter-sqlite`.

### Patch Changes

- Updated dependencies [[`46691c5`](https://github.com/haverstack/core/commit/46691c57f6b3b79f3d008fc29b2382c5eb3da006)]:
  - @haverstack/blob-adapter-disk@0.17.0
  - @haverstack/core@0.19.0
  - @haverstack/record-adapter-sqlite@0.11.0

## 0.17.0

### Minor Changes

- Released for a breaking change in `@haverstack/blob-adapter-disk`, `@haverstack/core`, `@haverstack/record-adapter-sqlite`.

### Patch Changes

- Updated dependencies [[`5324f8e`](https://github.com/haverstack/core/commit/5324f8ec4ef6ef2225f3c05661e3d3d1d860512b), [`f568011`](https://github.com/haverstack/core/commit/f568011af1f3ba41ea4671cd879b845285574eba), [`d0c0bb2`](https://github.com/haverstack/core/commit/d0c0bb25bae95f1285e2b2a0db980d0c4d215ac2), [`5324f8e`](https://github.com/haverstack/core/commit/5324f8ec4ef6ef2225f3c05661e3d3d1d860512b)]:
  - @haverstack/core@0.18.0
  - @haverstack/record-adapter-sqlite@0.10.0
  - @haverstack/blob-adapter-disk@0.16.0

## 0.16.0

### Minor Changes

- Released for a breaking change in `@haverstack/blob-adapter-disk`, `@haverstack/core`, `@haverstack/record-adapter-sqlite`.

### Patch Changes

- Updated dependencies [[`d27cfe4`](https://github.com/haverstack/core/commit/d27cfe4fc09406abda36c1c93f071446e13ef7b8)]:
  - @haverstack/blob-adapter-disk@0.15.0
  - @haverstack/record-adapter-sqlite@0.9.0
  - @haverstack/core@0.17.0

## 0.15.0

### Minor Changes

- Released for a breaking change in `@haverstack/blob-adapter-disk`, `@haverstack/core`, `@haverstack/record-adapter-sqlite`.

### Patch Changes

- Updated dependencies [[`609c320`](https://github.com/haverstack/core/commit/609c320728ff47cae3997042685a9fc2f7a12150)]:
  - @haverstack/core@0.16.0
  - @haverstack/blob-adapter-disk@0.14.0
  - @haverstack/record-adapter-sqlite@0.8.0

## 0.14.0

### Minor Changes

- [#209](https://github.com/haverstack/core/pull/209) [`9edf5d0`](https://github.com/haverstack/core/commit/9edf5d02925fc6db3d829c21e23150abf15d8a8f) Thanks [@cuibonobo](https://github.com/cuibonobo)! - Add an `unlisted` state for records — reachable by ID, absent from enumeration by default.

  `StackRecord.unlistedAt` is a native field, orthogonal to `permissions`: it says nothing
  about who may read a record, only whether it is enumerable. A record with `unlistedAt` set
  is reachable by `get()` for anyone who may already read it, and excluded from an unfiltered
  `query()` and the change feed by default — the same posture soft delete already has.
  - `stack.create(typeId, content, { unlisted: true })` creates a record already unlisted, so
    there is no window where it exists and is briefly enumerable.
  - `stack.setUnlisted(id, unlisted)` toggles it on an existing record, gated exactly like
    `setPermissions()` under `ScopedStack` — both decide who can discover a record, not merely
    read one already found.
  - `RecordFilter.includeUnlisted` and `SubscribeOptions.includeUnlisted` opt a query or
    subscription back in. Unlike `includeDeleted`, `includeUnlisted` is refused to everyone but
    the stack owner acting alone under `ScopedStack` — enumeration standing rests on nothing but
    ownership, so no grant or delegation carries it.
  - The change feed matches `query()`'s exclusion, with one exception: marking a record unlisted
    emits a dedicated `unlist` op (kind `deleted`) so a subscriber that already knows the record
    is told to drop it; relisting emits `list` (kind `changed`), an ordinary upsert like
    `undelete`. Every other transition — created unlisted, an edit while already unlisted, a
    purge of a record that was never listed — needs no special-casing, since it falls out of
    checking the record's current state.

  See docs/spec/access-control.md § Unlisted records and docs/spec/events.md § The unlisted
  transition.

### Patch Changes

- Updated dependencies [[`9edf5d0`](https://github.com/haverstack/core/commit/9edf5d02925fc6db3d829c21e23150abf15d8a8f)]:
  - @haverstack/blob-adapter-disk@0.13.0
  - @haverstack/core@0.15.0
  - @haverstack/record-adapter-sqlite@0.7.0

## 0.13.0

### Minor Changes

- Released for a breaking change in `@haverstack/blob-adapter-disk`, `@haverstack/core`, `@haverstack/record-adapter-sqlite`.

### Patch Changes

- Updated dependencies [[`d69e53b`](https://github.com/haverstack/core/commit/d69e53b287394c968b960beafdda27d1123f8386), [`7db6eaf`](https://github.com/haverstack/core/commit/7db6eaff9dd96eccbc9e96e7a104f3529aa708c9)]:
  - @haverstack/blob-adapter-disk@0.12.0
  - @haverstack/record-adapter-sqlite@0.6.0
  - @haverstack/core@0.14.0

## 0.12.0

### Minor Changes

- Released for a breaking change in `@haverstack/blob-adapter-disk`, `@haverstack/core`, `@haverstack/record-adapter-sqlite`.

### Patch Changes

- Updated dependencies [[`d556069`](https://github.com/haverstack/core/commit/d5560696f3ec1d08e9d49f66b79cbf2f5036dfef)]:
  - @haverstack/blob-adapter-disk@0.11.0
  - @haverstack/record-adapter-sqlite@0.5.0
  - @haverstack/core@0.13.0

## 0.11.0

### Minor Changes

- Released for a breaking change in `@haverstack/blob-adapter-disk`, `@haverstack/core`, `@haverstack/record-adapter-sqlite`.

### Patch Changes

- Updated dependencies [[`779ddd6`](https://github.com/haverstack/core/commit/779ddd6599c8b9049ca6fbf1516a4a54705e9609)]:
  - @haverstack/blob-adapter-disk@0.10.0
  - @haverstack/record-adapter-sqlite@0.4.0
  - @haverstack/core@0.12.0
