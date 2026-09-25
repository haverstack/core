---
'@haverstack/core': minor
'@haverstack/conformance-fixtures': minor
---

The `./wire` request parsers refuse input their endpoint does not define instead of ignoring it. `parseQueryParams()`, `parseChangeParams()` and `parseJournalParams()` throw `StackBadRequestError` for an unknown query param or a boolean param other than `true`/`false`. `parseQueryBody()` does the same for an unknown key at any depth, a non-object body, a non-boolean `includeDeleted`/`includeUnlisted` or a non-string `cursor`. `createOptionsFromWireRecord()` refuses a key no wire record carries. The rule is specified in docs/spec/wire-format.md § Unrecognized input, and four new error fixtures cover it.
