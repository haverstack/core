---
'@haverstack/core': minor
---

Rename `RecordChanges` (the `mutate()` input) to `RecordChangeSet`, and `RECORD_CHANGE_KEYS` to `RECORD_CHANGE_SET_KEYS`, so the input no longer differs by one letter from the `RecordChange` event `subscribe()` delivers. Type-only; no runtime or wire effect.
