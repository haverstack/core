# @haverstack/adapter-local

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
