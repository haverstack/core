---
'@haverstack/core': minor
'@haverstack/wire-types': patch
'@haverstack/sqlite-shared': patch
---

`NATIVE_SORT_FIELDS` is exported from `@haverstack/core`, and
`NativeSortField` is derived from it. The three native sort columns had
been spelled out four times across three packages — core's own wire-request
parser, `normalizeCapabilities()` in wire-types, the cursor decoder in
sqlite-shared, and the type itself — so adding a fourth column meant
finding all four. Each site now narrows against the one array, following
the same array-is-the-source-of-truth shape `GRANT_ACTIONS` already uses.
No behavior change: the set of accepted sort fields is what it was.
