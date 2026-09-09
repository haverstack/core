---
'@haverstack/record-adapter-sqlite': patch
'@haverstack/record-adapter-do-sqlite': patch
---

Keep `sanitizeFts5Query` linear in the length of the search text.

Several rules re-scanned the same run of input once per starting position
inside it, which is quadratic in that run — on text a caller types into a
search box. The rewrites are unchanged for every input FTS5 would accept;
a paren inside a `NEAR(...)` call now reads as grouping rather than being
swallowed with the wrapper, since no input FTS5 accepts puts one there.
