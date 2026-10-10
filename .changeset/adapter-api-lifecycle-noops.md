---
'@haverstack/adapter-api': minor
---

`APIAdapter` no longer defines `flush()` or `close()`. Both were no-ops, and both are optional on `StackAdapter`, so `Stack` skips them already; a caller invoking them directly on an `APIAdapter` can drop the call.

A discovery or auth handshake response that is empty or not JSON now throws `APIAdapterError` naming the endpoint, as every other success response does, rather than a `SyntaxError` or `TypeError`.
