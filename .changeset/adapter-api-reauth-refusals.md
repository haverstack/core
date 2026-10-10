---
'@haverstack/adapter-api': minor
---

Only a refused credential is reported as an authentication failure. A handshake step answering a bare `5xx` now throws `APIAdapterError` rather than `APIAdapterHandshakeError`, and a renewal that fails on a dropped connection or a server error surfaces as that `APIAdapterConnectionError` or `APIAdapterError` rather than as `APIAdapterReauthError`. A change feed whose renewal fails that way keeps reconnecting instead of stopping.
