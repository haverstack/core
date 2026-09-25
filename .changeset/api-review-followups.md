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

- The `Stack` prefix is reserved for the `StackError` taxonomy. The three local errors outside it are renamed: `StackClosedError` → `UseAfterCloseError`, `StackMisconfigurationError` → `InvalidAdapterError`, `StackRelayScopeError` → `RelayScopeError`.
- Every `@haverstack/core` export has exactly one entry point. `StackAdapter` moves to `@haverstack/core/adapter` beside its record and blob halves; `TokenSession` moves to `@haverstack/core/wire` beside `StackTokenStore` and `TokenInfo`; `StackCapabilities`, `ContentFilterReach`, `MissingCapability` and `IfVersionOptions` are exported from the root only; `@haverstack/core/wire` no longer re-exports `StackBadRequestError` or `StackValidationError`.
- `LocalAdapter.openOrInitialize()` throws `LocalAdapterOwnerMismatchError` (with `expectedOwnerEntityId`, `actualOwnerEntityId` and `path`) on an owner mismatch, and releases the database lock before throwing. `APIAdapterOwnerMismatchError.actualOwner` is now `actualOwnerEntityId`, matching.
- `DiskBlobAdapter` takes an options object, `new DiskBlobAdapter({ dir })`, like `S3BlobAdapter`.
