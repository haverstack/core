---
'@haverstack/core': patch
---

`assertValidSort()` narrows against `NATIVE_SORT_FIELDS` rather than its
own copy of the three column names, and names that array's contents in the
error a rejected sort field gets. It is the gate every query passes through
before an adapter sees it, so it was the copy a fourth native column could
least afford to be missing from — the wire parser would accept the field
and this would still refuse it, with no error pointing at the cause. No
behavior change: the set of accepted sort fields is what it was.
