/**
 * did:key for the three key types UCAN requires
 * -------------------------------------------------------
 * Core's own did:key support is Ed25519 only, since that is the floor it
 * mints. A UCAN verifier must also accept P-256 and secp256k1 issuers, so
 * this decodes all three multicodec prefixes, each with its compressed
 * public key, and reports which signature algorithm the key signs with.
 */

import { base58btc } from 'multiformats/bases/base58';
import { UcanError } from './errors.js';
import type { SignatureAlgorithm } from './varsig.js';
import { verifySignature } from './signature.js';

export type IssuerKey = {
  alg: SignatureAlgorithm;
  publicKey: Uint8Array;
};

/** Multicodec prefix (as LEB128) and key length for each public key type. */
const KEY_TYPES: { alg: SignatureAlgorithm; prefix: number[]; length: number }[] = [
  { alg: 'Ed25519', prefix: [0xed, 0x01], length: 32 },
  { alg: 'ES256', prefix: [0x80, 0x24], length: 33 },
  { alg: 'ES256K', prefix: [0xe7, 0x01], length: 33 },
];

/** A DID with any fragment removed. A fragment names a key, never a different principal. */
export const stripFragment = (did: string): string => {
  const hash = did.indexOf('#');
  return hash === -1 ? did : did.slice(0, hash);
};

/** The key behind a did:key, or null for any other DID method. */
export const parseDidKey = (did: string): IssuerKey | null => {
  const bare = stripFragment(did);
  if (!bare.startsWith('did:key:z')) return null;
  let bytes: Uint8Array;
  try {
    bytes = base58btc.decode(bare.slice('did:key:'.length));
  } catch {
    throw new UcanError('malformed', `Not a valid did:key: "${did}"`);
  }
  for (const { alg, prefix, length } of KEY_TYPES) {
    if (bytes.length === prefix.length + length && prefix.every((b, i) => bytes[i] === b)) {
      return { alg, publicKey: bytes.slice(prefix.length) };
    }
  }
  throw new UcanError('unsupported', `did:key is not an Ed25519, P-256 or secp256k1 key: "${did}"`);
};

/** The did:key naming a public key of the given type. */
export const didKeyFromPublicKey = (alg: SignatureAlgorithm, publicKey: Uint8Array): string => {
  const type = KEY_TYPES.find((t) => t.alg === alg)!;
  if (publicKey.length !== type.length) {
    throw new UcanError('malformed', `${alg} public key must be ${type.length} bytes.`);
  }
  return `did:key:${base58btc.encode(Uint8Array.from([...type.prefix, ...publicKey]))}`;
};

/**
 * The one answer to whether a DID signed something: a did:key of any type
 * UCAN accepts, or any other DID whose key `resolveKey` finds. validateChain()
 * resolves issuers the same way, so a server passing the same `resolveKey`
 * to both authenticates as principals exactly the identities it accepts as
 * issuers. Shaped as core's `DidSignatureVerifier`, the handshake's
 * `verifyDid`. A DID that can't be resolved, or a key that fails to
 * decode, verifies nothing.
 */
export const didVerifier =
  (options: { resolveKey?: (did: string) => Promise<IssuerKey | null> } = {}) =>
  async (did: string, signature: Uint8Array, payload: Uint8Array): Promise<boolean> => {
    try {
      const key = parseDidKey(did) ?? (await options.resolveKey?.(stripFragment(did))) ?? null;
      return key !== null && verifySignature(key.alg, key.publicKey, signature, payload);
    } catch {
      return false;
    }
  };
