---
'@haverstack/ucan': minor
---

New package: issue, decode and validate UCAN Delegation 1.0 tokens. Verifies Ed25519, P-256 and secp256k1 issuers with canonical signatures, evaluates the UCAN policy language, and checks a chain from its subject to its audience, handing the revocation check each link's upstream issuers. Powerline delegations are refused. `signedDelegation()` turns a validated chain into the delegation `Stack.asActor()` takes, over the `/haverstack/record/create|read|update|delete` commands. `acceptDelegation()` validates a chain presented with a handshake, for issuing a delegated token and for checking it again on each request. `didVerifier({ resolveKey })` is the handshake's `verifyDid` for a server accepting delegations, resolving keys exactly as chain validation does.
