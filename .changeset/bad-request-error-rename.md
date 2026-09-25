---
'@haverstack/core': minor
'@haverstack/adapter-api': minor
'@haverstack/blob-adapter-disk': minor
'@haverstack/blob-adapter-s3': minor
'@haverstack/conformance-fixtures': minor
'@haverstack/record-adapter-sqlite': minor
'@haverstack/wire-types': minor
---

Rename `StackQueryError` to `StackBadRequestError`, matching its wire code `bad_request`. It is thrown for any malformed request — bad record IDs, empty change sets, malformed TypeIds, unknown types, unusable `since` cursors, and every `./wire` parser — not only queries. The wire code and HTTP status are unchanged.
