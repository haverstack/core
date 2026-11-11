---
'@haverstack/ucan': minor
---

New package: issue, decode and validate UCAN Delegation 1.0 tokens. Verifies Ed25519, P-256 and secp256k1 issuers with canonical signatures, evaluates the UCAN policy language, and checks a chain from its subject to its audience, handing the revocation check each link's upstream issuers. Powerline delegations are refused. `delegationVerifier()` is the verifier `Stack.open({ verifyDelegation })` takes, over the `/haverstack/record/create|read|update|delete` commands, remembering did:key signatures by CID so per-operation validation stays cheap. `didVerifier({ resolveKey })` is the handshake's `verifyDid`, resolving keys exactly as chain validation does.
