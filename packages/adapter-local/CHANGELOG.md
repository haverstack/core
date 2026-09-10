# @haverstack/adapter-local

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
