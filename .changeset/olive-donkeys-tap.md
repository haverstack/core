---
'@haverstack/record-adapter-sqlite': minor
'@haverstack/record-adapter-do-sqlite': minor
---

Repair search text FTS5 cannot parse instead of failing on it, so `5" nails`, `cats AND`, `-cats` and `cats-dogs` search for the terms they name. Everything outside a phrase is now reduced to an allow-list rather than a list of metacharacters to strip: FTS5's column-filter syntax is wider than `colname:term` — `-name` and `{a b}` filter columns with no colon — so a leading minus and an ordinary hyphenated word were reaching the engine as column names. Also closes an odd trailing quote, drops operators left without an operand, writes back the `AND` a group needs beside it, and removes control characters, which truncate SQLite's C string. Text inside a phrase is left alone. Behind that, any parse failure still reaching the engine surfaces as `StackQueryError` (`bad_request`/400) rather than a raw engine error a server has no code to map — scoped to `filter.search`, the one filter carrying a query language, so a failure in a parameter-built clause is still reported as the bug it is.
