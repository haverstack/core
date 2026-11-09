---
'@haverstack/core': minor
---

`asActor()` takes a verified signed delegation (`{ delegation }`), which counts on the principal's side of the permission check beside grants naming the principal, for the record verbs and families it allows. `verifyAuthChallenge()` takes a `verifyDid` callback for DIDs other than `did:key`. New exported types: `SignedDelegation`, `DelegatedVerb` and `DidSignatureVerifier`. A `DidCredential` may carry a `delegation` chain for the handshake to present, `parseAuthTokenBody()` accepts `delegation`, and a `TokenSession` carries the `delegationChain` a delegated token was issued on. New `_revocation@1` system type: the owner refuses a signed delegation by writing one naming its CID, owner-only, ungrantable and recoverable like a grant; `Stack.isDelegationRevoked(cid)` answers whether a live one does. Exports `RevocationContent`.
