---
'@haverstack/adapter-api': minor
---

`APIAdapter` no longer defines `flush()` or `close()`. Both were no-ops, and both are optional on `StackAdapter`, so `Stack` skips them already; a caller invoking them directly on an `APIAdapter` can drop the call.
