import { ed25519 } from '@noble/curves/ed25519.js';
import { p256 } from '@noble/curves/nist.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import {
  didKeyFromPublicKey,
  issueDelegation,
  type DelegationOptions,
  type DelegationSigner,
  type SignatureAlgorithm,
} from '../src/index.js';

export type TestSigner = DelegationSigner & { alg: SignatureAlgorithm };

/** A signer for any of the three algorithms, backed by @noble/curves. */
export const makeSigner = (alg: SignatureAlgorithm = 'Ed25519'): TestSigner => {
  if (alg === 'Ed25519') {
    const secret = ed25519.utils.randomSecretKey();
    return {
      alg,
      did: didKeyFromPublicKey(alg, ed25519.getPublicKey(secret)),
      sign: async (m) => ed25519.sign(m, secret),
    };
  }
  const curve = alg === 'ES256' ? p256 : secp256k1;
  const secret = curve.utils.randomSecretKey();
  return {
    alg,
    did: didKeyFromPublicKey(alg, curve.getPublicKey(secret, true)),
    sign: async (m) => curve.sign(m, secret, { prehash: true, lowS: true }),
  };
};

/** A signer backed by Web Crypto Ed25519, the way core holds keys. */
export const makeWebCryptoSigner = async (): Promise<TestSigner> => {
  const pair = (await crypto.subtle.generateKey('Ed25519', true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  return {
    alg: 'Ed25519',
    did: didKeyFromPublicKey('Ed25519', raw),
    sign: async (m) =>
      new Uint8Array(await crypto.subtle.sign('Ed25519', pair.privateKey, m as BufferSource)),
  };
};

export const NOW = 1_800_000_000;

/** Issue with defaults: no expiry, the issuer as its own subject, `/` and no policy. */
export const issue = (issuer: TestSigner, overrides: Partial<DelegationOptions> = {}) =>
  issueDelegation({
    issuer,
    audience: makeSigner().did,
    subject: issuer.did,
    cmd: '/',
    exp: null,
    ...overrides,
  });
