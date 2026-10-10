/**
 * Stack — Decentralized Identifiers
 * -------------------------------------------------------
 * entityId values are DID strings (see docs/spec/identity.md). did:key —
 * an Ed25519 public key, multicodec + multibase(base58btc) encoded — is the
 * mandatory floor: zero infrastructure, zero resolution, verifiable by
 * anyone from the string alone. Other methods (did:web, did:plc, ...) are
 * valid entityId values too, but this module only knows how to mint and
 * verify did:key.
 *
 * Uses Web Crypto (crypto.subtle) exclusively — no dependency, works in
 * Node (>=22.5, matching the rest of core's floor), browsers, and Deno.
 */

// -------------------------------------------------------
// Errors
// -------------------------------------------------------

export class InvalidDidError extends Error {
  constructor(message = '') {
    super(message || 'Invalid DID.');
    this.name = 'InvalidDidError';
  }
}

// -------------------------------------------------------
// base58btc (Bitcoin alphabet) — no leading-zero-safe library dependency
// -------------------------------------------------------

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

const base58btcEncode = (bytes: Uint8Array): string => {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);

  let out = '';
  while (value > 0n) {
    const remainder = value % 58n;
    value /= 58n;
    out = BASE58_ALPHABET[Number(remainder)] + out;
  }

  for (const byte of bytes) {
    if (byte !== 0) break;
    out = '1' + out;
  }

  return out;
};

const base58btcDecode = (encoded: string): Uint8Array => {
  let value = 0n;
  for (const char of encoded) {
    const digit = BASE58_ALPHABET.indexOf(char);
    if (digit === -1) {
      throw new InvalidDidError(`Invalid base58 character: "${char}"`);
    }
    value = value * 58n + BigInt(digit);
  }

  const bytes: number[] = [];
  while (value > 0n) {
    bytes.unshift(Number(value & 0xffn));
    value >>= 8n;
  }

  for (const char of encoded) {
    if (char !== '1') break;
    bytes.unshift(0);
  }

  return new Uint8Array(bytes);
};

// -------------------------------------------------------
// did:key (Ed25519)
// -------------------------------------------------------

/** Multicodec varint prefix for "ed25519-pub" (code 0xed). */
const ED25519_MULTICODEC_PREFIX = new Uint8Array([0xed, 0x01]);
const ED25519_RAW_KEY_LENGTH = 32;
const DID_KEY_PREFIX = 'did:key:z';
/** Multicodec prefix plus raw key — what a did:key's base58 payload decodes to. */
const DID_KEY_DECODED_LENGTH = ED25519_MULTICODEC_PREFIX.length + ED25519_RAW_KEY_LENGTH;
// base58btc expands by at most log(256)/log(58) characters per byte, so a
// longer payload cannot decode to DID_KEY_DECODED_LENGTH bytes. Screening on
// it keeps base58btcDecode's BigInt accumulation, which is quadratic in its
// input, off strings whose length the caller never bounded.
const DID_KEY_MAX_BASE58_LENGTH = Math.ceil(
  DID_KEY_DECODED_LENGTH * (Math.log(256) / Math.log(58)),
);

export type DidKeypair = {
  /** e.g. "did:key:z6Mk..." */
  did: string;
  publicKey: CryptoKey;
  privateKey: CryptoKey;
};

/** Generate a fresh Ed25519 keypair and derive its did:key. */
export const generateDidKeypair = async (): Promise<DidKeypair> => {
  const { publicKey, privateKey } = (await crypto.subtle.generateKey('Ed25519', true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  return { did: await didFromPublicKey(publicKey), publicKey, privateKey };
};

/** Derive a did:key string from an Ed25519 CryptoKey. */
export const didFromPublicKey = async (publicKey: CryptoKey): Promise<string> => {
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', publicKey));
  const prefixed = new Uint8Array(ED25519_MULTICODEC_PREFIX.length + raw.length);
  prefixed.set(ED25519_MULTICODEC_PREFIX, 0);
  prefixed.set(raw, ED25519_MULTICODEC_PREFIX.length);
  return DID_KEY_PREFIX + base58btcEncode(prefixed);
};

/**
 * Parse a did:key string and return its raw Ed25519 public key bytes, or
 * null if it isn't a well-formed Ed25519 did:key (wrong prefix, bad base58,
 * wrong multicodec, wrong length).
 */
export const parseDidKey = (did: string): Uint8Array | null => {
  if (!did.startsWith(DID_KEY_PREFIX)) return null;

  const encoded = did.slice(DID_KEY_PREFIX.length);
  if (encoded.length > DID_KEY_MAX_BASE58_LENGTH) return null;

  let decoded: Uint8Array;
  try {
    decoded = base58btcDecode(encoded);
  } catch {
    return null;
  }

  if (
    decoded.length !== DID_KEY_DECODED_LENGTH ||
    decoded[0] !== ED25519_MULTICODEC_PREFIX[0] ||
    decoded[1] !== ED25519_MULTICODEC_PREFIX[1]
  ) {
    return null;
  }

  return decoded.slice(ED25519_MULTICODEC_PREFIX.length);
};

/** Whether a string is a well-formed Ed25519 did:key. */
export const isValidDidKey = (value: string): boolean => parseDidKey(value) !== null;

/** Import the Ed25519 public key encoded in a did:key, for verification. */
export const publicKeyFromDidKey = async (did: string): Promise<CryptoKey> => {
  const raw = parseDidKey(did);
  if (!raw) throw new InvalidDidError(`Not a valid did:key: "${did}"`);
  return crypto.subtle.importKey('raw', new Uint8Array(raw), 'Ed25519', true, ['verify']);
};

// -------------------------------------------------------
// Generic DID syntax (any method)
// -------------------------------------------------------

// did-core ABNF, simplified: "did:" method-name ":" method-specific-id
const GENERIC_DID_FORMAT = /^did:[a-z0-9]+:[A-Za-z0-9._:%-]+$/;

/**
 * Whether a string has the generic W3C DID Core syntax (did:<method>:<id>)
 * — any method, not just did:key. Use isValidDidKey() to additionally
 * require the did:key method and a well-formed Ed25519 key.
 */
export const isValidDid = (value: string): boolean => GENERIC_DID_FORMAT.test(value);

// -------------------------------------------------------
// Sign / verify
// -------------------------------------------------------

export const signWithDid = async (privateKey: CryptoKey, data: Uint8Array): Promise<Uint8Array> =>
  new Uint8Array(await crypto.subtle.sign('Ed25519', privateKey, new Uint8Array(data)));

/**
 * Verify a signature was produced by the private key behind a did:key.
 * Requires no lookup — the public key is decoded from the DID itself.
 */
export const verifyDidSignature = async (
  did: string,
  signature: Uint8Array,
  data: Uint8Array,
): Promise<boolean> => {
  const publicKey = await publicKeyFromDidKey(did);
  return crypto.subtle.verify(
    'Ed25519',
    publicKey,
    new Uint8Array(signature),
    new Uint8Array(data),
  );
};

// -------------------------------------------------------
// Private-key export/import
// -------------------------------------------------------
//
// Core never stores a private key itself — these exist so callers can
// persist the key material returned by generateDidKeypair() (encrypted key
// backup, OS keychain, etc.) and reconstruct it on a later run. Where that
// key lives is an app/UX concern, not this library's.

export const exportDidPrivateKeyJwk = async (privateKey: CryptoKey): Promise<JsonWebKey> =>
  crypto.subtle.exportKey('jwk', privateKey);

export const importDidPrivateKeyJwk = async (jwk: JsonWebKey): Promise<CryptoKey> =>
  crypto.subtle.importKey('jwk', jwk, 'Ed25519', true, ['sign']);
