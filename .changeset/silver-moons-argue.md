---
'@haverstack/adapter-api': minor
---

Refuse a plaintext `http://` URL to a non-loopback host, before the credential is spent or anything is sent: the bearer token, the handshake signature and every record would travel in the clear. `localhost`, `127.0.0.0/8` and `::1` are unaffected. Pass `allowInsecure: true` where the transport is already private.
