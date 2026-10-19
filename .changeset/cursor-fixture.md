---
'@haverstack/conformance-fixtures': minor
---

Remove `error-bad-request-unknown-sort-field-cursor`: scoped cursors are sealed and bound to their query, so a client can no longer send one naming a sort field, and every cursor the server did not issue is `error-bad-request-malformed-cursor`.
