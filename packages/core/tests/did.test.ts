import { describe, test, expect } from 'vitest';
import {
  generateDidKeypair,
  didFromPublicKey,
  parseDidKey,
  isValidDidKey,
  isValidDid,
  publicKeyFromDidKey,
  signWithDid,
  verifyDidSignature,
  exportDidPrivateKeyJwk,
  importDidPrivateKeyJwk,
  InvalidDidError,
} from '../src/did.js';

describe('generateDidKeypair', () => {
  test('produces a well-formed did:key string', async () => {
    const { did } = await generateDidKeypair();
    expect(did.startsWith('did:key:z')).toBe(true);
    expect(isValidDidKey(did)).toBe(true);
  });

  test('produces distinct DIDs on each call', async () => {
    const a = await generateDidKeypair();
    const b = await generateDidKeypair();
    expect(a.did).not.toBe(b.did);
  });

  test('didFromPublicKey matches the DID returned by generateDidKeypair', async () => {
    const { did, publicKey } = await generateDidKeypair();
    expect(await didFromPublicKey(publicKey)).toBe(did);
  });
});

describe('parseDidKey / isValidDidKey', () => {
  test('round-trips a generated DID back to its 32-byte raw public key', async () => {
    const { did, publicKey } = await generateDidKeypair();
    const raw = new Uint8Array(await crypto.subtle.exportKey('raw', publicKey));
    expect(parseDidKey(did)).toEqual(raw);
  });

  test('accepts the well-known W3C did:key Ed25519 example', () => {
    // https://www.w3.org/TR/did-key/#example-ed25519-x25519-example
    const did = 'did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK';
    expect(isValidDidKey(did)).toBe(true);
    expect(parseDidKey(did)).toHaveLength(32);
  });

  test('rejects non-did:key input', () => {
    expect(parseDidKey('did:web:example.com')).toBeNull();
    expect(parseDidKey('not-a-did')).toBeNull();
    expect(parseDidKey('')).toBeNull();
    expect(isValidDidKey('did:web:example.com')).toBe(false);
  });

  test('rejects invalid base58 in the key portion', () => {
    expect(parseDidKey('did:key:z0OIl')).toBeNull();
  });

  test('rejects a did:key whose decoded bytes are the wrong length', () => {
    // Valid base58btc, but far too short to be a multicodec-prefixed Ed25519 key.
    expect(parseDidKey('did:key:z6Mk')).toBeNull();
  });
});

describe('isValidDid', () => {
  test('accepts generic DID syntax across methods', () => {
    expect(isValidDid('did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK')).toBe(true);
    expect(isValidDid('did:web:example.com')).toBe(true);
    expect(isValidDid('did:plc:abc123')).toBe(true);
  });

  test('rejects malformed strings', () => {
    expect(isValidDid('not-a-did')).toBe(false);
    expect(isValidDid('did:')).toBe(false);
    expect(isValidDid('did:key:')).toBe(false);
    expect(isValidDid('')).toBe(false);
  });
});

describe('publicKeyFromDidKey', () => {
  test('imports a usable verification key', async () => {
    const { did, privateKey } = await generateDidKeypair();
    const publicKey = await publicKeyFromDidKey(did);
    const data = new TextEncoder().encode('hello');
    const sig = await signWithDid(privateKey, data);
    expect(await crypto.subtle.verify('Ed25519', publicKey, new Uint8Array(sig), data)).toBe(true);
  });

  test('throws InvalidDidError for a malformed did:key', async () => {
    await expect(publicKeyFromDidKey('did:key:not-valid')).rejects.toThrow(InvalidDidError);
  });
});

describe('signWithDid / verifyDidSignature', () => {
  test('verifies a signature produced by the matching private key', async () => {
    const { did, privateKey } = await generateDidKeypair();
    const data = new TextEncoder().encode('a nonce to sign');
    const signature = await signWithDid(privateKey, data);
    expect(await verifyDidSignature(did, signature, data)).toBe(true);
  });

  test('rejects a signature over different data', async () => {
    const { did, privateKey } = await generateDidKeypair();
    const signature = await signWithDid(privateKey, new TextEncoder().encode('original'));
    expect(await verifyDidSignature(did, signature, new TextEncoder().encode('tampered'))).toBe(
      false,
    );
  });

  test('rejects a signature from a different keypair', async () => {
    const a = await generateDidKeypair();
    const b = await generateDidKeypair();
    const data = new TextEncoder().encode('a nonce to sign');
    const signature = await signWithDid(a.privateKey, data);
    expect(await verifyDidSignature(b.did, signature, data)).toBe(false);
  });
});

describe('private key JWK export/import', () => {
  test('round-trips a private key so it can still sign', async () => {
    const { did, privateKey } = await generateDidKeypair();
    const jwk = await exportDidPrivateKeyJwk(privateKey);
    const restored = await importDidPrivateKeyJwk(jwk);

    const data = new TextEncoder().encode('persisted across a restart');
    const signature = await signWithDid(restored, data);
    expect(await verifyDidSignature(did, signature, data)).toBe(true);
  });
});
