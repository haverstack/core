---
'@haverstack/core': patch
---

`Stack` and `ScopedStack` accept an internal write expectation on every write verb — the record's Type family, and on a content write its exact version — checked against the read each write already makes, so a typed collection's write is refused before anything lands and costs no extra round trip.
