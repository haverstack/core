---
'@haverstack/adapter-api': minor
---

A discovery or auth handshake response that is empty or not JSON now throws `APIAdapterError` naming the endpoint, as every other success response does, rather than a `SyntaxError` or `TypeError`.
