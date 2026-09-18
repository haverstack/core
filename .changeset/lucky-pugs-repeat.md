---
'@haverstack/core': patch
---

Harden `MemoryAdapter`'s pagination cursor codec. The cursor descriptor embeds `sort.contentField` verbatim, so a non-Latin-1 field name made bare `btoa()` throw an `InvalidCharacterError` (a `DOMException`, not a `StackError`) out of an otherwise valid query — it now goes through the same explicit UTF-8 step the SQLite adapters' codec uses. Decoding also rejects a negative offset, which was previously accepted and slid the page window to the end of the result set.
