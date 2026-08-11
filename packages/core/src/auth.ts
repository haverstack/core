/**
 * Stack — Authentication handshake primitives
 * -------------------------------------------------------
 * The challenge–response handshake proves a client holds the key behind a
 * DID, so a server can issue it a bearer token without an out-of-band
 * secret handoff. See docs/spec/wire-format.md § Authentication.
 *
 * What lives here is the half both sides must agree on byte for byte: the
 * payload that gets signed. A client builds it to sign; a server builds it
 * to verify. Two implementations of "the same string" would diverge on the
 * first ambiguity, and the failure mode is a signature that verifies
 * against a payload nobody meant — so there is one constructor, exported,
 * the same way the attachment content-type policy is shared rather than
 * re-derived.
 *
 * Core verifies signatures; it does not run a server. Nonce storage,
 * single-use enforcement and token issuance are the server's.
 */

import { isValidDid, signWithDid, verifyDidSignature, type DidKeypair } from './did.js';

// -------------------------------------------------------
// Errors
// -------------------------------------------------------

/**
 * Malformed input to a handshake primitive — a bad origin, DID, or nonce,
 * caught locally before anything is signed or verified. Outside the
 * StackError hierarchy, like InvalidDidError: no Stack operation has begun,
 * so there is no wire code or status to carry (docs/spec/wire-format.md
 * § The taxonomy root).
 */
export class InvalidAuthChallengeError extends Error {
  constructor(message = '') {
    super(message || 'Invalid authentication challenge.');
    this.name = 'InvalidAuthChallengeError';
  }
}

// -------------------------------------------------------
// The signed payload
// -------------------------------------------------------

/**
 * Domain-separation tag. Version it rather than the payload's shape: a
 * future signing primitive picks its own tag, so no signature made for one
 * purpose can ever verify as another.
 */
export const AUTH_PAYLOAD_LABEL = 'haverstack-auth-v1';

/**
 * A server-issued nonce is opaque, but not arbitrary — it lands in a
 * newline-delimited payload, so the charset is what keeps a nonce from
 * spanning fields. base64url, hex and UUID all satisfy it.
 */
const NONCE_FORMAT = /^[A-Za-z0-9_-]+$/;

export type AuthChallenge = {
  /** The server's own public origin, e.g. "https://stack.example.com". */
  origin: string;
  /** The DID being proven. */
  did: string;
  /** The nonce the server issued for this DID. */
  nonce: string;
};

/**
 * Reduce a URL to the origin form the payload uses: scheme, host and a
 * non-default port. A client derives it from the URL it dialed; a server
 * MUST derive it from its own configured public origin rather than from a
 * request header, which a client controls.
 */
export const authOriginFromUrl = (url: string): string => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new InvalidAuthChallengeError(`Not a valid URL: "${url}"`);
  }
  // Opaque origins ("null") come from schemes with no host to bind to —
  // there is nothing for a signature to be scoped by.
  if (parsed.origin === 'null') {
    throw new InvalidAuthChallengeError(`URL has no origin to bind a signature to: "${url}"`);
  }
  return parsed.origin;
};

/**
 * Build the exact bytes a client signs and a server verifies.
 *
 * The origin is in the payload because the nonce alone doesn't scope a
 * signature to a server: one that a client connects to can fetch a
 * challenge from the client's real stack, pass that nonce along, and
 * redeem the returned signature as a token. Signing the origin the client
 * believes it is talking to makes such a signature verify nowhere else.
 */
export const buildAuthChallengePayload = (challenge: AuthChallenge): Uint8Array => {
  const origin = authOriginFromUrl(challenge.origin);
  if (!isValidDid(challenge.did)) {
    throw new InvalidAuthChallengeError(`Not a valid DID: "${challenge.did}"`);
  }
  if (!NONCE_FORMAT.test(challenge.nonce)) {
    throw new InvalidAuthChallengeError(
      'Nonce must be a non-empty string of unreserved base64url characters.',
    );
  }
  return new TextEncoder().encode(
    `${AUTH_PAYLOAD_LABEL}\n${origin}\n${challenge.did}\n${challenge.nonce}`,
  );
};

// -------------------------------------------------------
// Sign / verify
// -------------------------------------------------------

/** Sign a challenge with the private key behind its DID. */
export const signAuthChallenge = async (
  privateKey: CryptoKey,
  challenge: AuthChallenge,
): Promise<Uint8Array> => signWithDid(privateKey, buildAuthChallengePayload(challenge));

/**
 * Verify a challenge signature. Answers only "this signature was made by
 * the key behind this DID, for this origin and nonce" — whether the nonce
 * was ever issued, is unexpired, and has not already been spent is the
 * server's to track, and all three matter.
 */
export const verifyAuthChallenge = async (
  challenge: AuthChallenge,
  signature: Uint8Array,
): Promise<boolean> => {
  const payload = buildAuthChallengePayload(challenge);
  try {
    return await verifyDidSignature(challenge.did, signature, payload);
  } catch {
    // A DID whose key can't be decoded verifies nothing — a false answer,
    // not an exceptional one, since the caller asked whether it verifies.
    return false;
  }
};

// -------------------------------------------------------
// Credentials
// -------------------------------------------------------

/**
 * What a client hands an adapter to authenticate: a DID and a signing
 * callback, never a private key. Key custody stays with the app (see
 * docs/spec/identity.md), so a caller is free to back this with a hardware
 * key, an OS keychain, or a prompt.
 */
export type DidCredential = {
  did: string;
  sign: (payload: Uint8Array) => Promise<Uint8Array>;
};

/**
 * Build a credential from a keypair, for callers holding key material in
 * process and wanting no ceremony. Anything else implements DidCredential
 * directly.
 */
export const didCredentialFromKeypair = (keypair: DidKeypair): DidCredential => ({
  did: keypair.did,
  sign: (payload: Uint8Array) => signWithDid(keypair.privateKey, payload),
});

// -------------------------------------------------------
// base64url — how a signature travels in JSON
// -------------------------------------------------------

export const base64urlEncode = (bytes: Uint8Array): string => {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

export const base64urlDecode = (encoded: string): Uint8Array => {
  if (!NONCE_FORMAT.test(encoded)) {
    throw new InvalidAuthChallengeError('Not valid base64url.');
  }
  const padded = encoded.replace(/-/g, '+').replace(/_/g, '/');
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    throw new InvalidAuthChallengeError('Not valid base64url.');
  }
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
};
