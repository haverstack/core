---
'@haverstack/core': minor
'@haverstack/wire-types': minor
'@haverstack/adapter-api': minor
'@haverstack/conformance-fixtures': minor
'@haverstack/record-adapter-sqlite': minor
---

Move `parentId` and `unlisted` off the version tier

A move and a listing transition no longer bump `version`, take a snapshot, or
read `ifVersion`. Both join `associations` in the journal tier, whose entry
already records them in full: a `reparent` carries `previousParentId`, and
`unlist`/`list` is its own inverse.

`RecordVersion` and `WireVersion` lose `parentId`, and the SQLite `versions`
table loses its `parent_id` column. `restoreVersion()` correspondingly settles
`content` and `typeId` alone — it leaves a record in whatever container it is
in now, which removes the ancestor-cycle walk, the reference gate on the
snapshot's container, and the second-container routing a restore used to get
on the change feed.

`version` is now documented as the ordinal of a record's snapshot history
rather than a count of its changes; the journal's `seq` is what counts every
change.
