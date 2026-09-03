---
'@haverstack/record-adapter-sqlite': minor
'@haverstack/record-adapter-do-sqlite': minor
---

Repair search text FTS5 cannot parse instead of failing on it: an odd trailing quote is closed and operators left without an operand are dropped, so `5" nails` and `cats AND` search for the terms they name. Text inside a phrase is left alone. Behind that, any parse failure still reaching the engine surfaces as `StackQueryError` (`bad_request`/400) rather than a raw engine error a server has no code to map — scoped to `filter.search`, the one filter carrying a query language, so a failure in a parameter-built clause is still reported as the bug it is.
