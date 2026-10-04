---
'@haverstack/adapter-api': minor
---

Percent-encode record IDs, versions and fileIds as single URL path segments, so an ID holding `/`, `?` or `#` cannot address a different endpoint. An ID of `.` or `..` is refused with `StackBadRequestError` before any request is sent.
