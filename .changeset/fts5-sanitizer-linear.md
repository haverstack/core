---
'@haverstack/record-adapter-sqlite': patch
'@haverstack/record-adapter-do-sqlite': patch
---

Stop `sanitizeFts5Query` collapsing on adversarial search text.

Several rules re-scanned the same run of input once per starting position
inside it, which is quadratic in that run — on text a caller types into a
search box. A few hundred kilobytes of the right shape held the thread for
seconds to minutes; the same inputs now take tens of milliseconds.

This bounds the collapse, not the growth: sanitizing still costs a little
more than proportionally as the search text grows, so bounding that text's
length remains the caller's.

The rewrites are unchanged for every input FTS5 would accept. A paren
inside a `NEAR(...)` call now reads as grouping rather than being
swallowed with the wrapper, since no input FTS5 accepts puts one there.
