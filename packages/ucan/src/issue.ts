/**
 * Issuing delegations
 * -------------------------------------------------------
 * The issuer signs through a callback, never by handing over a private
 * key: the same `{ did, sign }` credential core's handshake takes, so
 * whatever holds the key (a keychain, a hardware key, a prompt) holds it
 * here too. The issuer must be a did:key, since that is what names the
 * signature algorithm.
 */

import * as dagCbor from '@ipld/dag-cbor';
import { parseDidKey } from './did-key.js';
import {
  DELEGATION_TAG,
  decodeDelegation,
  validatePayload,
  type Delegation,
  type DelegationPayload,
} from './delegation.js';
import { UcanError } from './errors.js';
import type { IpldValue } from './policy.js';
import { normalizeLowS, verifySignature } from './signature.js';
import { encodeVarsigHeader } from './varsig.js';

export type DelegationSigner = {
  did: string;
  sign: (payload: Uint8Array) => Promise<Uint8Array>;
};

export type DelegationOptions = {
  issuer: DelegationSigner;
  audience: string;
  subject: string;
  cmd: string;
  /** Defaults to no constraints. */
  pol?: IpldValue[];
  /** Unix seconds, or null for a delegation that never expires. */
  exp: number | null;
  nbf?: number;
  meta?: { [key: string]: IpldValue };
  /** Defaults to 16 random bytes. */
  nonce?: Uint8Array;
};

export const issueDelegation = async (options: DelegationOptions): Promise<Delegation> => {
  const key = parseDidKey(options.issuer.did);
  if (!key) throw new UcanError('unsupported', 'A delegation issuer must be a did:key.');

  const payload: DelegationPayload = {
    iss: options.issuer.did,
    aud: options.audience,
    sub: options.subject,
    cmd: options.cmd,
    pol: options.pol ?? [],
    nonce: options.nonce ?? crypto.getRandomValues(new Uint8Array(16)),
    exp: options.exp,
    ...(options.nbf !== undefined && { nbf: options.nbf }),
    ...(options.meta !== undefined && { meta: options.meta }),
  };
  validatePayload(payload);

  const sigPayload = { h: encodeVarsigHeader(key.alg), [DELEGATION_TAG]: payload };
  const signedBytes = dagCbor.encode(sigPayload);
  const signature = normalizeLowS(key.alg, await options.issuer.sign(signedBytes));
  // A signer holding a different key than its DID names would produce a
  // delegation nothing accepts; say so here rather than at its first use.
  if (!verifySignature(key.alg, key.publicKey, signature, signedBytes)) {
    throw new UcanError('signature', 'The signer did not sign with the key its DID names.');
  }
  return decodeDelegation(dagCbor.encode([signature, sigPayload]));
};
