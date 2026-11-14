/**
 * Varsig v1 headers
 * -------------------------------------------------------
 * A UCAN envelope names its signature algorithm and payload encoding in a
 * Varsig header rather than leaving a verifier to guess. UCAN requires
 * Ed25519, P-256 and secp256k1, always over DAG-CBOR, so a header is one of
 * three fixed byte strings and is matched whole rather than parsed field by
 * field: anything else is refused, never interpreted.
 */

import { UcanError } from './errors.js';

export type SignatureAlgorithm = 'Ed25519' | 'ES256' | 'ES256K';

const PREFIX = [0x34, 0x01];
const DAG_CBOR = [0x71];

/** Each algorithm's segments, as LEB128 varints: family, curve, hash. */
const ALGORITHMS: Record<SignatureAlgorithm, number[]> = {
  // EdDSA (0xed), edwards25519 (0xed), SHA2-512 (0x13)
  Ed25519: [0xed, 0x01, 0xed, 0x01, 0x13],
  // ECDSA (0xec), P-256 (0x1200), SHA2-256 (0x12)
  ES256: [0xec, 0x01, 0x80, 0x24, 0x12],
  // ECDSA (0xec), secp256k1 (0xe7), SHA2-256 (0x12)
  ES256K: [0xec, 0x01, 0xe7, 0x01, 0x12],
};

export const encodeVarsigHeader = (alg: SignatureAlgorithm): Uint8Array =>
  Uint8Array.from([...PREFIX, ...ALGORITHMS[alg], ...DAG_CBOR]);

export const decodeVarsigHeader = (header: Uint8Array): SignatureAlgorithm => {
  for (const alg of Object.keys(ALGORITHMS) as SignatureAlgorithm[]) {
    const expected = encodeVarsigHeader(alg);
    if (expected.length === header.length && expected.every((b, i) => b === header[i])) {
      return alg;
    }
  }
  throw new UcanError(
    'unsupported',
    'Varsig header is not Ed25519, ES256 or ES256K over DAG-CBOR.',
  );
};
