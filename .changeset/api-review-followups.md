---
'@haverstack/core': minor
'@haverstack/adapter-api': minor
'@haverstack/adapter-local': minor
'@haverstack/blob-adapter-disk': minor
'@haverstack/wire-types': patch
'@haverstack/record-adapter-sqlite': patch
'@haverstack/adapter-conformance': patch
---

Follow-ups to the API consistency pass.

- The `Stack` prefix is reserved for the `StackError` taxonomy. The local errors outside it are renamed: `StackClosedError` → `UseAfterCloseError` and `StackRelayScopeError` → `RelayScopeError`.
- Every `@haverstack/core` export has exactly one entry point. `StackAdapter` moves from the root to `@haverstack/core/adapter`, beside its record and blob halves; `TokenSession` moves from the root to `@haverstack/core/wire`, beside `StackTokenStore` and `TokenInfo`; `ContentFilterReach` and `MissingCapability` are no longer exported from `@haverstack/core/adapter`, only the root; and `@haverstack/core/wire` no longer re-exports the root's errors (`StackValidationError`, and `StackQueryError` under its new name `StackBadRequestError`).
- `LocalAdapter.openOrInitialize()` throws `LocalAdapterOwnerMismatchError` (with `expectedOwnerEntityId`, `actualOwnerEntityId` and `path`) on an owner mismatch, and releases the database lock before throwing. `APIAdapterOwnerMismatchError`'s `expectedOwner`/`actualOwner` fields are now `expectedOwnerEntityId`/`actualOwnerEntityId`, matching.
- `DiskBlobAdapter` takes an options object, `new DiskBlobAdapter({ dir })`, like `S3BlobAdapter`.
