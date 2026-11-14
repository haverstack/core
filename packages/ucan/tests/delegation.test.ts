import { describe, expect, it } from 'vitest';
import * as dagCbor from '@ipld/dag-cbor';
import { p256 } from '@noble/curves/nist.js';
import {
  DELEGATION_TAG,
  decodeDelegation,
  decodeVarsigHeader,
  didKeyFromPublicKey,
  encodeVarsigHeader,
  issueDelegation,
  parseDidKey,
  UcanError,
  validateChain,
  type SignatureAlgorithm,
} from '../src/index.js';
import { issue, makeSigner, makeWebCryptoSigner } from './helpers.js';

const ALGS: SignatureAlgorithm[] = ['Ed25519', 'ES256', 'ES256K'];

/** Rebuild an envelope around a modified signature payload, re-signed by `signer`. */
const reenvelope = async (
  signer: { sign: (m: Uint8Array) => Promise<Uint8Array> },
  alg: SignatureAlgorithm,
  payload: Record<string, unknown>,
  tag = DELEGATION_TAG,
) => {
  const sigPayload = { h: encodeVarsigHeader(alg), [tag]: payload };
  const signature = await signer.sign(dagCbor.encode(sigPayload));
  return dagCbor.encode([signature, sigPayload]);
};

const codeOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (e) {
    if (e instanceof UcanError) return e.code;
    throw e;
  }
  return 'accepted';
};

describe('varsig headers', () => {
  it('encode Ed25519 as the spec example does', () => {
    expect(Buffer.from(encodeVarsigHeader('Ed25519')).toString('base64')).toBe('NAHtAe0BE3E=');
  });

  it('round-trip each algorithm and refuse anything else', () => {
    for (const alg of ALGS) expect(decodeVarsigHeader(encodeVarsigHeader(alg))).toBe(alg);
    // ES384: a valid Varsig, but not one UCAN requires.
    expect(() =>
      decodeVarsigHeader(Uint8Array.of(0x34, 0x01, 0xec, 0x01, 0x81, 0x24, 0x20, 0x71)),
    ).toThrow(UcanError);
  });
});

describe('did:key', () => {
  it('round-trips each key type', () => {
    for (const alg of ALGS) {
      const { did } = makeSigner(alg);
      const key = parseDidKey(did)!;
      expect(key.alg).toBe(alg);
      expect(didKeyFromPublicKey(alg, key.publicKey)).toBe(did);
      expect(parseDidKey(`${did}#${did.slice(8)}`)).toEqual(key);
    }
  });

  it('returns null for other methods and refuses unknown key types', () => {
    expect(parseDidKey('did:web:example.com')).toBeNull();
    expect(() => parseDidKey('did:key:z6LSbysY2xFMRpGMhb7tFTLMpeuPRaqaWM1yECx2AtzE3KCc')).toThrow(
      UcanError,
    );
  });

  it('decodes the P-256 did:key test vector from the did:key spec', () => {
    const key = parseDidKey('did:key:zDnaerDaTF5BXEavCrfRZEk316dpbLsfPDZ3WJ5hRTPFU2169')!;
    expect(key.alg).toBe('ES256');
    expect(() => p256.Point.fromBytes(key.publicKey)).not.toThrow();
  });
});

describe('issue and decode', () => {
  it.each(ALGS)('round-trips a %s delegation that verifies', async (alg) => {
    const issuer = makeSigner(alg);
    const d = await issue(issuer, {
      cmd: '/haverstack/record/read',
      pol: [['==', '.baseId', 'note']],
      exp: 2e9,
    });
    const decoded = await decodeDelegation(d.bytes);
    expect(decoded).toMatchObject({
      iss: issuer.did,
      sub: issuer.did,
      cmd: '/haverstack/record/read',
      exp: 2e9,
      alg,
      cid: d.cid,
    });
    expect(decoded.cid).toMatch(/^zdpu/);
    await expect(validateChain([decoded], { now: 1e9 })).resolves.toMatchObject({
      subject: issuer.did,
    });
  });

  it('accepts a Web Crypto signer, the shape core credentials take', async () => {
    const issuer = await makeWebCryptoSigner();
    const d = await issue(issuer);
    await expect(validateChain([d])).resolves.toBeDefined();
  });

  it('normalizes a high-S ECDSA signature when issuing, and refuses one when verifying', async () => {
    for (const alg of ['ES256', 'ES256K'] as const) {
      const issuer = makeSigner(alg);
      const curve = (
        await import(alg === 'ES256' ? '@noble/curves/nist.js' : '@noble/curves/secp256k1.js')
      )[alg === 'ES256' ? 'p256' : 'secp256k1'];
      const flip = (sig: Uint8Array) => {
        const s = curve.Signature.fromBytes(sig, 'compact');
        return new curve.Signature(s.r, curve.Point.Fn.ORDER - s.s).toBytes('compact');
      };
      const highS = { ...issuer, sign: async (m: Uint8Array) => flip(await issuer.sign(m)) };
      const d = await issue(highS);
      await expect(validateChain([d])).resolves.toBeDefined();

      // The same token carrying the high-S twin of its signature.
      const [sig, sigPayload] = dagCbor.decode(d.bytes) as [Uint8Array, unknown];
      const twin = await decodeDelegation(dagCbor.encode([flip(sig), sigPayload]));
      expect(await codeOf(validateChain([twin]))).toBe('signature');
    }
  });

  it('refuses a signer whose key is not the one its DID names', async () => {
    const issuer = makeSigner();
    const other = makeSigner();
    expect(await codeOf(issue({ ...issuer, sign: other.sign }))).toBe('signature');
  });

  it('refuses a tampered payload', async () => {
    const issuer = makeSigner();
    const d = await issue(issuer, { cmd: '/haverstack/record/read' });
    const [sig, sigPayload] = dagCbor.decode(d.bytes) as [
      Uint8Array,
      Record<string, { cmd: string }>,
    ];
    sigPayload[DELEGATION_TAG].cmd = '/haverstack/record';
    const tampered = await decodeDelegation(dagCbor.encode([sig, sigPayload]));
    expect(await codeOf(validateChain([tampered]))).toBe('signature');
  });

  it('refuses bytes that are not the canonical encoding of what they decode to', async () => {
    const d = await issue(makeSigner());
    // A non-minimal length prefix for the two-element envelope array.
    const noncanonical = Uint8Array.from([0x98, 0x02, ...d.bytes.slice(1)]);
    expect(await codeOf(decodeDelegation(noncanonical))).toBe('malformed');
    expect(await codeOf(decodeDelegation(Uint8Array.from([...d.bytes, 0])))).toBe('malformed');
  });

  it('refuses another spec version, an unknown field, and a missing one', async () => {
    const issuer = makeSigner();
    const d = await issue(issuer);
    const payload = {
      iss: d.iss,
      aud: d.aud,
      sub: d.sub,
      cmd: d.cmd,
      pol: d.pol,
      nonce: d.nonce,
      exp: d.exp,
    };
    expect(await codeOf(decodeDelegation(await reenvelope(issuer, 'Ed25519', payload)))).toBe(
      'accepted',
    );
    expect(
      await codeOf(
        decodeDelegation(await reenvelope(issuer, 'Ed25519', payload, 'ucan/dlg@1.0.0-rc.1')),
      ),
    ).toBe('malformed');
    expect(
      await codeOf(decodeDelegation(await reenvelope(issuer, 'Ed25519', { ...payload, prf: [] }))),
    ).toBe('malformed');
    const { exp: _exp, ...noExp } = payload;
    expect(await codeOf(decodeDelegation(await reenvelope(issuer, 'Ed25519', noExp)))).toBe(
      'malformed',
    );
  });

  it('refuses an invalid command, policy or timestamp at issue', async () => {
    const issuer = makeSigner();
    expect(await codeOf(issue(issuer, { cmd: '/Upper' }))).toBe('malformed');
    expect(await codeOf(issue(issuer, { cmd: '/trailing/' }))).toBe('malformed');
    expect(await codeOf(issue(issuer, { pol: [['nope']] }))).toBe('malformed');
    expect(await codeOf(issue(issuer, { exp: 1.5 }))).toBe('malformed');
  });

  it('refuses a non-did:key issuer at issue', async () => {
    const issuer = { ...makeSigner(), did: 'did:web:example.com' };
    expect(
      await codeOf(
        issueDelegation({ issuer, audience: issuer.did, subject: issuer.did, cmd: '/', exp: null }),
      ),
    ).toBe('unsupported');
  });
});
