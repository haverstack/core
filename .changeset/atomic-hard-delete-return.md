---
'@haverstack/core': minor
'@haverstack/conformance-fixtures': minor
---

Add `deleteAndReturn()` — an atomic read-and-destroy, for a caller that needs the record too

Hard delete leaves nothing to read once the row is destroyed, so a caller
that also needs the record for its own response — a server building `DELETE
/records/:id?hard=true`'s body, in particular — had to read the record
separately before calling `delete()`. That opened a window between the read
and the destroy: a concurrent write with no `If-Match` to fence it could land
in the gap, get destroyed by the purge, and never appear in the response.

`Stack.deleteAndReturn()` and `ScopedStack.deleteAndReturn()` close it:
`delete()`'s own read-and-destroy, reported back instead of discarded.
`{ record, referencedFileIds }` — `record` is the record exactly as it stood
at the moment of destruction for a hard delete, or the resulting tombstone
for a soft one, captured inside the same write rather than a read beforehand.
`delete()` is unchanged, now expressed as `deleteAndReturn()` with `record`
dropped. `ScopedStack.deleteAndReturn()` is gated identically to `delete()`,
including the existence/visibility check that produces `404` ahead of the
`403` permission gate.

`@haverstack/conformance-fixtures` gains `deleteRecordSequenceFixtures`,
pinning that a hard delete's response reflects a write landing immediately
before it rather than a copy read earlier.
