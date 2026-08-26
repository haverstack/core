# @haverstack/wire-types

## 0.12.0

### Minor Changes

- Released for a breaking change in `@haverstack/core`.

### Patch Changes

- Updated dependencies [[`d556069`](https://github.com/haverstack/core/commit/d5560696f3ec1d08e9d49f66b79cbf2f5036dfef)]:
  - @haverstack/core@0.13.0

## 0.11.0

### Minor Changes

- [#191](https://github.com/haverstack/core/pull/191) [`ca0acdc`](https://github.com/haverstack/core/commit/ca0acdc78e6861fc371140b040898ce28279c435) Thanks [@cuibonobo](https://github.com/cuibonobo)! - Add the change-feed wire types: `WireRecordChange` and `serializeChange()`, the `ready`/`record`/`reset` frame names and their payloads, `DiscoveryChanges` with `supportsChangeFeed()`, and `isValidSeq()` for the cursor charset.

  `serializeChange()` drops the record, its parent, and everything else identifying it from a `purged` frame, whatever the caller passes. A server holds the purged record at emission — readability can only be evaluated before the write — so enforcing the rule in the encoding puts it where the leak would otherwise start.

## 0.10.0

### Minor Changes

- Released for a breaking change in `@haverstack/core`.

### Patch Changes

- Updated dependencies [[`779ddd6`](https://github.com/haverstack/core/commit/779ddd6599c8b9049ca6fbf1516a4a54705e9609)]:
  - @haverstack/core@0.12.0
