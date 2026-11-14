/**
 * UCAN Delegation 1.0 envelopes
 * -------------------------------------------------------
 * A delegation travels as one DAG-CBOR value: `[signature, { h, "ucan/dlg@1.0.0": payload }]`,
 * where `h` is the Varsig header and the signature covers the DAG-CBOR
 * encoding of that second element. Decoding is strict: the bytes must be
 * the canonical encoding of what they decode to, the payload must carry
 * exactly the fields the spec defines, and only the 1.0.0 tag is accepted.
 * A token that differs from its canonical form could carry a second CID for
 * one signature, and an unrecognized field is one this package would sign
 * off on without understanding.
 */

import * as dagCbor from '@ipld/dag-cbor';
import { CID } from 'multiformats/cid';
import { base58btc } from 'multiformats/bases/base58';
import { sha256 } from 'multiformats/hashes/sha2';
import { isValidCommand } from './command.js';
import { UcanError } from './errors.js';
import { parsePolicy, type IpldValue, type Policy } from './policy.js';
import { decodeVarsigHeader, type SignatureAlgorithm } from './varsig.js';

export const DELEGATION_TAG = 'ucan/dlg@1.0.0';

/** The fields of a delegation payload, as the issuer signed them. */
export type DelegationPayload = {
  iss: string;
  aud: string;
  /** The principal the chain is about. `null` is a Powerline delegation. */
  sub: string | null;
  cmd: string;
  pol: IpldValue[];
  nonce: Uint8Array;
  meta?: { [key: string]: IpldValue };
  /** Unix seconds. */
  nbf?: number;
  /** Unix seconds; `null` never expires. */
  exp: number | null;
};

export type Delegation = Readonly<
  DelegationPayload & {
    /** The parsed `pol`. */
    policy: Policy;
    alg: SignatureAlgorithm;
    signature: Uint8Array;
    /** The bytes the signature covers. */
    signedBytes: Uint8Array;
    /** The whole envelope, as it travels and is stored. */
    bytes: Uint8Array;
    /** CIDv1, DAG-CBOR, SHA-256, base58btc: how a revocation names this delegation. */
    cid: string;
  }
>;

const REQUIRED = ['iss', 'aud', 'sub', 'cmd', 'pol', 'nonce', 'exp'] as const;
const OPTIONAL = ['meta', 'nbf'] as const;
const KNOWN = new Set<string>([...REQUIRED, ...OPTIONAL]);

/** A loose `did:<method>:<id>` check; whether a method is supported is the verifier's question. */
const DID_FORMAT = /^did:[a-z0-9]+:[A-Za-z0-9._:%-]+(#[^\s]*)?$/;

const malformed = (message: string): UcanError => new UcanError('malformed', message);

const isPlainMap = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  !(value instanceof Uint8Array) &&
  CID.asCID(value) === null;

const isTimestamp = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value);

/**
 * Check a payload's shape and return its parsed policy. Shared by decoding
 * and issuing, so a delegation this package issues is one it would accept.
 */
export const validatePayload = (payload: unknown): Policy => {
  if (!isPlainMap(payload)) throw malformed('Delegation payload must be a map.');
  for (const key of Object.keys(payload)) {
    if (!KNOWN.has(key)) throw malformed(`Unknown delegation field "${key}".`);
  }
  for (const key of REQUIRED) {
    if (!Object.hasOwn(payload, key)) throw malformed(`Delegation is missing "${key}".`);
  }
  const { iss, aud, sub, cmd, pol, nonce, meta, nbf, exp } = payload;
  if (typeof iss !== 'string' || !DID_FORMAT.test(iss)) throw malformed('"iss" must be a DID.');
  if (typeof aud !== 'string' || !DID_FORMAT.test(aud)) throw malformed('"aud" must be a DID.');
  if (sub !== null && (typeof sub !== 'string' || !DID_FORMAT.test(sub))) {
    throw malformed('"sub" must be a DID or null.');
  }
  if (!isValidCommand(cmd)) throw malformed(`"cmd" is not a valid command: ${String(cmd)}`);
  if (!(nonce instanceof Uint8Array)) throw malformed('"nonce" must be bytes.');
  if (meta !== undefined && !isPlainMap(meta)) throw malformed('"meta" must be a map.');
  if (nbf !== undefined && !isTimestamp(nbf)) throw malformed('"nbf" must be an integer.');
  if (exp !== null && !isTimestamp(exp)) throw malformed('"exp" must be an integer or null.');
  return parsePolicy(pol);
};

export const delegationCid = async (bytes: Uint8Array): Promise<string> =>
  CID.create(1, dagCbor.code, await sha256.digest(bytes)).toString(base58btc);

const bytesEqual = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * Decode a delegation envelope. Checks structure and canonical encoding,
 * not the signature or the chain: see validateChain().
 */
export const decodeDelegation = async (bytes: Uint8Array): Promise<Delegation> => {
  let decoded: unknown;
  try {
    decoded = dagCbor.decode(bytes);
  } catch {
    throw malformed('Delegation is not valid DAG-CBOR.');
  }
  if (!bytesEqual(dagCbor.encode(decoded), bytes)) {
    throw malformed('Delegation is not canonically encoded.');
  }
  if (!Array.isArray(decoded) || decoded.length !== 2) {
    throw malformed('Envelope must be [signature, signature payload].');
  }
  const [signature, sigPayload] = decoded as [unknown, unknown];
  if (!(signature instanceof Uint8Array)) throw malformed('Envelope signature must be bytes.');
  if (!isPlainMap(sigPayload)) throw malformed('Signature payload must be a map.');
  const keys = Object.keys(sigPayload);
  if (keys.length !== 2 || !keys.includes('h') || !keys.includes(DELEGATION_TAG)) {
    throw malformed(`Signature payload must hold exactly "h" and "${DELEGATION_TAG}".`);
  }
  const header = sigPayload.h;
  if (!(header instanceof Uint8Array)) throw malformed('Varsig header must be bytes.');
  const alg = decodeVarsigHeader(header);

  const payload = sigPayload[DELEGATION_TAG];
  const policy = validatePayload(payload);
  return {
    ...(payload as DelegationPayload),
    policy,
    alg,
    signature,
    signedBytes: dagCbor.encode(sigPayload),
    bytes,
    cid: await delegationCid(bytes),
  };
};
