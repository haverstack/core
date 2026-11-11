# @haverstack/ucan

[UCAN Delegation 1.0](https://github.com/ucan-wg/delegation) for Haverstack: issue a delegation, decode one, and validate a chain of them.

A delegation is how one identity signs that another may act for it. This package implements the published UCAN specs rather than a format of its own, and verifies only: it has no transport, storage or invocation. It lives outside `@haverstack/core` so the core library stays dependency-free; nothing in core requires it.

> **Status:** Early development. APIs are unstable.

## Installation

```sh
npm install @haverstack/ucan
```

## Issuing

The issuer signs through a callback, never by handing over a private key. It is the same `{ did, sign }` shape `@haverstack/core/wire`'s `didCredentialFromKeypair()` returns.

```ts
import { issueDelegation } from '@haverstack/ucan';

const delegation = await issueDelegation({
  issuer: credential, // { did, sign }
  audience: appDid,
  subject: credential.did,
  cmd: '/haverstack/record/read',
  pol: [['like', '.baseId', 'commons/*']],
  exp: Math.floor(Date.now() / 1000) + 3600,
});

delegation.bytes; // the envelope, as it travels and is stored
delegation.cid; // how a revocation names it
```

The issuer must be a `did:key`. ECDSA signatures are normalized to low-S before encoding.

## Validating

```ts
import { authorizes, decodeDelegation, validateChain } from '@haverstack/ucan';

const chain = await validateChain(await Promise.all(tokens.map(decodeDelegation)), {
  isRevoked: (cid) => revoked.has(cid),
});
chain.subject; // whose authority the chain carries
chain.audience; // who may act under it
chain.expiresAt; // the earliest exp, or null

authorizes(chain, '/haverstack/record/read', { baseId: 'commons/note' }); // true
```

`validateChain()` takes the chain root first and checks:

- **Encoding:** each envelope is the canonical DAG-CBOR encoding of a `ucan/dlg@1.0.0` payload with exactly the spec's fields. Decoding refuses anything else.
- **Signatures:** Ed25519, P-256 and secp256k1, as UCAN requires. Ed25519 is verified under strict RFC 8032 rules, and ECDSA only in low-S compact form, so a token has one valid signature and one CID. Non-`did:key` issuers resolve through the `resolveKey` option.
- **Principal alignment:** the first delegation is issued by its subject, and each later one by the previous audience, ignoring DID fragments.
- **Time bounds:** every link's `nbf` and `exp`, with 60 seconds of clock skew by default.
- **Revocation:** each link's CID against the `isRevoked` option, which also receives the issuers upstream of that link, who may revoke it.

`authorizes()` then asks whether every link's command proves the one invoked and every link's policy accepts the arguments.

## Serving delegated sessions

A server opens its stack with `delegationVerifier()`. The stack then validates the chain a session carries on every operation, with its own revocations, so a server never handles a verified delegation itself:

```ts
import { delegationVerifier, didVerifier } from '@haverstack/ucan';

const resolveKey = undefined; // or a resolver for DID methods other than did:key
const stack = await Stack.open(adapter, { verifyDelegation: delegationVerifier({ resolveKey }) });
const verifyDid = didVerifier({ resolveKey });

// At POST /auth/token, when the body carries a delegationChain:
if (!(await verifyAuthChallenge(challenge, signature, { verifyDid }))) throw unauthorized();
const { subjectId, expiresAt } = await stack.verifyDelegationChain(chain, did);
await tokens.createToken(
  { subjectId, principalId: did, delegationChain: chain },
  { expiresAt: expiresAt ?? undefined },
);

// On each request:
const scoped = stack.asActor(await tokens.lookupToken(bearer));
```

Answer `DelegationRefusedError` with `invalid_delegation` at `/auth/token` and with 401 on any other request. Passing the same `resolveKey` to both means a server authenticates as principals exactly the identities it accepts as issuers.

Haverstack's commands mirror its grant actions: `/haverstack/record/create`, `/haverstack/record/read`, `/haverstack/record/update` and `/haverstack/record/delete`, each with `{ baseId }` as the arguments a policy constrains. `/haverstack/record` covers all four and will never cover more, so delegating it can't later grant something new. The delegation counts on the app's side of the stack's permission check, beside grants naming the app, and never reaches further than the subject's own grants. A did:key link's signature is checked once and remembered by CID, so revalidating on every operation costs only the time bounds and the revocation check.

A delegation's issuer, or the owner, revokes it by writing a `_revocation` Record naming its CID. See [Access control § Signed delegations](../../docs/spec/access-control.md#signed-delegations).

## Readings of the spec

Where the UCAN specs are ambiguous or leave a choice, this package takes the following, pinned by its tests:

- **Powerline delegations (`sub: null`) are refused.** A stack grants through its own records, so a chain always names its subject.
- **A quantifier takes one statement**, as the policy schema and every example give it.
- **An empty `or` is true**, as the spec states, and so is `any` over an empty collection.
- **`[]` in a selector fails** if any element fails the rest of the path.
- **Only the 1.0.0 payload tag is accepted**, and a payload carrying any field the spec doesn't define is refused.

## Interoperability

The test suite exchanges delegations with [iso-ucan](https://www.npmjs.com/package/iso-ucan), an independent implementation, in both directions.
