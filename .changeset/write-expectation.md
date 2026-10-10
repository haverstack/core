---
'@haverstack/core': minor
---

`Stack` and `ScopedStack` accept an internal write expectation on every write verb — the record's Type family, and on a content write its exact version — checked against the read each write already makes, so a typed write is refused before anything lands and costs no extra round trip. A typed `mutate()` or `patchContent()` now uses it: a record of another family is not found, and one stored at another version of the family is still refused with `StackBadRequestError`. `ScopedStack.amendAssociations()` and `amendAccess()` take their options third and `surface` fourth, as `Stack`'s do.
