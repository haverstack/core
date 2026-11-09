---
'@haverstack/wire-types': minor
'@haverstack/adapter-api': minor
'@haverstack/conformance-fixtures': minor
'@haverstack/record-adapter-sqlite': minor
'@haverstack/record-adapter-do-sqlite': minor
---

The handshake accepts a signed delegation. Servers advertise the `ucan-delegation` auth method and `POST /auth/token` takes `delegation`, a UCAN chain from a subject to the authenticating key, issuing a token that acts for that subject; a chain that fails to validate is the new `invalid_delegation` code. `APIAdapter` sends a credential's delegation, refuses a server that doesn't advertise the method, and refuses a session for any other subject. The SQLite token store keeps a delegated token's chain and returns it from `lookupToken()` and `listTokens()`; its `tokens` table gains a `delegation_chain` column. New conformance fixtures pin the delegated handshake with real signatures.
