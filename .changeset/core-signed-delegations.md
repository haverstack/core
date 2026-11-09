---
'@haverstack/core': minor
---

`asActor()` takes a verified signed delegation (`{ delegation }`), which counts on the principal's side of the permission check beside grants naming the principal, for the record verbs and families it allows. `verifyAuthChallenge()` takes a `verifyDid` callback for DIDs other than `did:key`. New exported types: `SignedDelegation`, `DelegatedVerb` and `DidSignatureVerifier`.
