---
'@haverstack/core': minor
'@haverstack/adapter-api': minor
'@haverstack/adapter-local': minor
'@haverstack/adapter-conformance': minor
'@haverstack/blob-adapter-disk': minor
'@haverstack/blob-adapter-s3': minor
'@haverstack/record-adapter-sqlite': minor
'@haverstack/record-adapter-do-sqlite': minor
'@haverstack/wire-types': patch
---

Align the adapter vocabulary with the client's.

- The version precondition is `ifVersion` on both sides of the `Stack`/adapter boundary: `StackRecordAdapter` methods take `IfVersionOptions` (`{ ifVersion?: number }`) and `ExpectedVersionOptions` is removed. `IfVersionOptions` is now also exported from `@haverstack/core/adapter`. `StackVersionConflictError.expectedVersion` and the wire payload are unchanged.
- Capabilities have one name: `AdapterCapabilities` is renamed `StackCapabilities`, the `StackFeatures` alias is removed, and `Stack.features`, `ScopedStack.features` and `StackClient.features` are renamed `capabilities`.
- `StackBlobAdapter` methods are renamed `putBlob`, `getBlob`, `deleteBlob` and `listBlobs`, and `BlobFileInfo` is renamed `BlobInfo`, so "attachment" names only the record-backed `Stack` operation. `putAttachmentWithMetadata` keeps its name. The blob conformance suite's `listFiles` option is renamed `listBlobs`.
