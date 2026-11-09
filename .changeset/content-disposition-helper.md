---
'@haverstack/core': minor
'@haverstack/conformance-fixtures': minor
'@haverstack/adapter-api': minor
---

`@haverstack/core/wire` exports `contentDispositionFilename()`, the one encoder for an attachment filename in `Content-Disposition`: a quoted ASCII fallback plus an RFC 8187 `filename*`. `attachmentContentDisposition()` builds a download's header from it — every download now carries one, `inline` unless the type was forced — and `APIAdapter` now sends it on upload. `parseUploadFilename()` is renamed `parseContentDispositionFilename()`, beside the encoder it inverts, and decodes `filename*` only when its charset is UTF-8. Download fixtures pin the disposition and filename on forced and inline downloads alike, and upload fixtures expect the new header.
