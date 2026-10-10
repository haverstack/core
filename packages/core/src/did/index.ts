/**
 * @haverstack/core/did
 * -------------------------------------------------------
 * Key generation, custody and signing for did:key — the mandatory-floor
 * DID method (see docs/spec/identity.md). Audience: apps at first-run
 * keygen and key custody, and protocol implementers verifying signatures.
 */

export { InvalidDidError, generateDidKeypair, verifyDidSignature } from './did.js';
export type { DidKeypair } from './did.js';

// No in-repo caller: haverstack/server#54 validates ENTITY_ID as a DID at
// server startup.
export { isValidDid } from './did.js';

// No in-repo caller: it exists for callers needing the did:key narrowing
// isValidDid()'s docstring points to — rejecting a method
// verifyDidSignature() cannot verify, without attempting one.
export { isValidDidKey } from './did.js';

// No in-repo caller: root README.md § Key custody documents
// exportDidPrivateKeyJwk() -> store -> importDidPrivateKeyJwk() ->
// signWithDid() as the key-custody journey an app follows.
export { signWithDid, exportDidPrivateKeyJwk, importDidPrivateKeyJwk } from './did.js';
