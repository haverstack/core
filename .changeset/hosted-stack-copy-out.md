---
'@haverstack/core': minor
'@haverstack/wire-types': minor
'@haverstack/conformance-fixtures': minor
'@haverstack/adapter-api': minor
'@haverstack/adapter-local': minor
'@haverstack/blob-adapter-disk': minor
'@haverstack/blob-adapter-s3': minor
'@haverstack/adapter-conformance': minor
'@haverstack/record-adapter-sqlite': minor
'@haverstack/record-adapter-do-sqlite': minor
---

A hosted stack's owner can copy it out over the wire with `copyStack(host, create)`.

- `head()`, an optional adapter method, says where a store's writes stand: the same string until anything is written, a different one after. Every local adapter has one; `combineAdapters()` and `LocalAdapter` combine both halves'. `WriteHead` in `@haverstack/core/adapter` is the counter they share.
- `copyStack()` reads the source's head before and after, and refuses with `StackConflictError` if they differ. A source or target without `head()` is refused with `InvalidAdapterError`.
- `listBlobs({ afterFileId?, limit? })` pages in `fileId` order on every blob adapter. `blobWindow()`, `FILE_ID_RE` and `assertFileId()` in `@haverstack/core/adapter` are shared by the blob adapters.
- `GET /blobs` and `GET /head` serve the owner acting alone, advertised in discovery as `blobs: { list: true }` and `head: { read: true }`. `APIAdapter.listBlobs()` and `APIAdapter.head()` are present only when advertised. `@haverstack/wire-types` adds `WireBlobsResponse`, `WireHeadResponse`, `serializeBlobInfo()`, `supportsBlobListing()` and `supportsHead()`; `@haverstack/core/wire` adds `parseBlobsParams()`.
- Every record adapter states `writers: 'owner' | 'shared'`, who writes its store. `Stack` reads it, not the presence of `subscribeChanges()`, to refuse scoping a shared stack, and refuses `subscribe()` with `StackBadRequestError` on a shared stack with no relay. `APIAdapter` is `'shared'`, and its `subscribeChanges()` is present only when discovery advertises a feed; it no longer throws `APIAdapterCapabilityError` for a missing one.
- Conformance fixtures for both endpoints and their discovery keys; the adapter conformance suites check that `head()`, where an adapter has one, moves on every write method and stands still across reads.
