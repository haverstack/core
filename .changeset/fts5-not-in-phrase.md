---
'@haverstack/record-adapter-sqlite': patch
'@haverstack/record-adapter-do-sqlite': patch
---

`filter.search` no longer drops a `NOT` written inside a quoted phrase: `"cats (not dogs"` searches for the phrase as typed.
