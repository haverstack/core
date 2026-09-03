---
'@haverstack/core': minor
---

Raise `StackQueryError` (`bad_request`/400) rather than a bare `Error` for a `typeId` no definition exists for and for a malformed TypeId. Both are client-reachable over the wire, and an error outside the `StackError` taxonomy has no code for a server to map, so ordinary requests answered as 500s.
