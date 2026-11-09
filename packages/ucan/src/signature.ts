/**
 * Signature verification
 * -------------------------------------------------------
 * UCAN requires canonical signatures, so a third party can't derive a
 * second valid signature and with it a second CID for the same token:
 * strict RFC 8032 Ed25519 and low-S ECDSA, both in the 64-byte compact
 * form. @noble/curves enforces both the same way in every runtime, which
 * Web Crypto does not promise.
 */

import { ed25519 } from '@noble/curves/ed25519.js';
import { p256 } from '@noble/curves/nist.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import type { SignatureAlgorithm } from './varsig.js';

const ECDSA = { ES256: p256, ES256K: secp256k1 } as const;

export const verifySignature = (
  alg: SignatureAlgorithm,
  publicKey: Uint8Array,
  signature: Uint8Array,
  message: Uint8Array,
): boolean => {
  if (signature.length !== 64) return false;
  try {
    if (alg === 'Ed25519') return ed25519.verify(signature, message, publicKey, { zip215: false });
    return ECDSA[alg].verify(signature, message, publicKey, {
      prehash: true,
      lowS: true,
      format: 'compact',
    });
  } catch {
    // A key or signature that fails to decode verifies nothing.
    return false;
  }
};

/**
 * An ECDSA signature with `s` moved to the low half of the curve order.
 * Web Crypto signs with either half; both verify, but only the low one is
 * canonical, so an issuer normalizes before encoding.
 */
export const normalizeLowS = (alg: SignatureAlgorithm, signature: Uint8Array): Uint8Array => {
  if (alg === 'Ed25519') return signature;
  const curve = ECDSA[alg];
  const sig = curve.Signature.fromBytes(signature, 'compact');
  if (!sig.hasHighS()) return signature;
  return new curve.Signature(sig.r, curve.Point.Fn.ORDER - sig.s).toBytes('compact');
};
