---
'@haverstack/core': minor
'@haverstack/wire-types': minor
'@haverstack/conformance-fixtures': minor
'@haverstack/adapter-api': minor
'@haverstack/adapter-local': minor
'@haverstack/blob-adapter-disk': minor
'@haverstack/blob-adapter-s3': minor
'@haverstack/adapter-conformance': minor
---

A hosted stack's owner can copy it out over the wire with `copyStack(host, create)`.

- `listBlobs({ afterFileId?, limit? })` pages in `fileId` order on every blob adapter. `blobWindow()` in `@haverstack/core/adapter` windows an unordered set of names the same way.
- `GET /blobs` lists every blob for the owner acting alone, advertised in discovery as `blobs: { list: true }`. `APIAdapter.listBlobs()` is present when it is. `@haverstack/wire-types` adds `WireBlobsResponse`, `serializeBlobInfo()` and `supportsBlobListing()`; `@haverstack/core/wire` adds `parseBlobsParams()`.
- `SubscribeOptions.onReady` reports the head cursor a relay came up at.
- `copyStack()` watches a source that relays changes, and refuses it with `StackConflictError` if a change arrives or its head moved by the end of the copy. A relay reporting no head is refused with `InvalidAdapterError`.
- Conformance fixtures for `GET /blobs`, its discovery key, and a head that stays the same while nothing changes.
