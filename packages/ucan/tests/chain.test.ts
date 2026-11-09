import { describe, expect, it } from 'vitest';
import * as dagCbor from '@ipld/dag-cbor';
import {
  DELEGATION_TAG,
  decodeDelegation,
  encodeVarsigHeader,
  parseDidKey,
  authorizes,
  issueDelegation,
  UcanError,
  validateChain,
  type ChainOptions,
  type Delegation,
} from '../src/index.js';
import { issue, makeSigner, NOW } from './helpers.js';

const codeOf = async (chain: Delegation[], options: ChainOptions = { now: NOW }) => {
  try {
    await validateChain(chain, options);
    return 'valid';
  } catch (e) {
    if (e instanceof UcanError) return e.code;
    throw e;
  }
};

describe('validateChain', () => {
  it('validates a subject → app → device chain and reports its bounds', async () => {
    const alice = makeSigner();
    const app = makeSigner('ES256');
    const device = makeSigner('ES256K');
    const root = await issue(alice, { audience: app.did, exp: NOW + 600, nbf: NOW - 10 });
    const leaf = await issue(app, { audience: device.did, subject: alice.did, exp: NOW + 60 });
    await expect(validateChain([root, leaf], { now: NOW })).resolves.toMatchObject({
      subject: alice.did,
      audience: device.did,
      notBefore: NOW - 10,
      expiresAt: NOW + 60,
    });
  });

  it('requires the first delegation to be issued by its subject', async () => {
    const alice = makeSigner();
    const mallory = makeSigner();
    const d = await issue(mallory, { subject: alice.did });
    expect(await codeOf([d])).toBe('misaligned');
  });

  it('requires each delegation to be issued by the previous audience', async () => {
    const alice = makeSigner();
    const app = makeSigner();
    const stranger = makeSigner();
    const root = await issue(alice, { audience: app.did });
    const leaf = await issue(stranger, { subject: alice.did });
    expect(await codeOf([root, leaf])).toBe('misaligned');
  });

  it('requires every link to name the same subject', async () => {
    const alice = makeSigner();
    const app = makeSigner();
    const root = await issue(alice, { audience: app.did });
    const leaf = await issue(app, { subject: app.did });
    expect(await codeOf([root, leaf])).toBe('misaligned');
  });

  it('refuses Powerline delegations', async () => {
    const alice = makeSigner();
    const app = makeSigner();
    const root = await issue(alice, { audience: app.did });
    const powerline = await issueDelegation({
      issuer: app,
      audience: makeSigner().did,
      subject: null as unknown as string,
      cmd: '/',
      exp: null,
    });
    expect(powerline.sub).toBeNull();
    expect(await codeOf([powerline])).toBe('misaligned');
    expect(await codeOf([root, powerline])).toBe('misaligned');
  });

  it('ignores DID fragments when aligning principals', async () => {
    const alice = makeSigner();
    const app = makeSigner();
    const root = await issue(alice, { audience: `${app.did}#key-1` });
    const leaf = await issue(app, { subject: alice.did });
    expect(await codeOf([root, leaf])).toBe('valid');
  });

  it('applies time bounds with the clock skew, to every link', async () => {
    const alice = makeSigner();
    const app = makeSigner();
    const root = await issue(alice, { audience: app.did, exp: NOW });
    const leaf = await issue(app, { subject: alice.did, nbf: NOW });
    expect(await codeOf([root, leaf], { now: NOW + 60 })).toBe('valid');
    expect(await codeOf([root, leaf], { now: NOW + 61 })).toBe('expired');
    expect(await codeOf([root, leaf], { now: NOW - 60 })).toBe('valid');
    expect(await codeOf([root, leaf], { now: NOW - 61 })).toBe('not-yet-valid');
    expect(await codeOf([root, leaf], { now: NOW + 61, clockSkew: 0 })).toBe('expired');
  });

  it('refuses a chain with a revoked link', async () => {
    const alice = makeSigner();
    const app = makeSigner();
    const root = await issue(alice, { audience: app.did });
    const leaf = await issue(app, { subject: alice.did });
    expect(await codeOf([root, leaf], { isRevoked: (cid) => cid === root.cid })).toBe('revoked');
  });

  it('resolves non-did:key issuers through resolveKey, and refuses them without it', async () => {
    const key = makeSigner();
    const did = 'did:example:alice';
    const sigPayload = {
      h: encodeVarsigHeader('Ed25519'),
      [DELEGATION_TAG]: {
        iss: did,
        aud: makeSigner().did,
        sub: did,
        cmd: '/',
        pol: [],
        nonce: Uint8Array.of(1),
        exp: null,
      },
    };
    const signature = await key.sign(dagCbor.encode(sigPayload));
    const d = await decodeDelegation(dagCbor.encode([signature, sigPayload]));
    expect(await codeOf([d])).toBe('unsupported');

    const resolveKey = async (asked: string) => (asked === did ? parseDidKey(key.did) : null);
    expect(await codeOf([d], { now: NOW, resolveKey })).toBe('valid');
    const wrongKey = async () => parseDidKey(makeSigner().did);
    expect(await codeOf([d], { now: NOW, resolveKey: wrongKey })).toBe('signature');
    const wrongAlg = async () => parseDidKey(makeSigner('ES256').did);
    expect(await codeOf([d], { now: NOW, resolveKey: wrongAlg })).toBe('signature');
  });

  it('refuses an empty chain', async () => {
    expect(await codeOf([])).toBe('misaligned');
  });
});

describe('authorizes', () => {
  it('requires every link to prove the command and accept the arguments', async () => {
    const alice = makeSigner();
    const app = makeSigner();
    const root = await issue(alice, { audience: app.did, cmd: '/haverstack/record' });
    const leaf = await issue(app, {
      subject: alice.did,
      cmd: '/haverstack/record/read',
      pol: [['like', '.baseId', 'commons/*']],
    });
    const chain = await validateChain([root, leaf], { now: NOW });
    expect(authorizes(chain, '/haverstack/record/read', { baseId: 'commons/note' })).toBe(true);
    expect(authorizes(chain, '/haverstack/record/read', { baseId: 'private/diary' })).toBe(false);
    expect(authorizes(chain, '/haverstack/record/update', { baseId: 'commons/note' })).toBe(false);
    expect(authorizes(chain, '/haverstack/recorded/read', { baseId: 'commons/note' })).toBe(false);
  });

  it('lets a narrower root bound a broader leaf', async () => {
    const alice = makeSigner();
    const app = makeSigner();
    const root = await issue(alice, { audience: app.did, cmd: '/haverstack/record/read' });
    const leaf = await issue(app, { subject: alice.did, cmd: '/' });
    const chain = await validateChain([root, leaf], { now: NOW });
    expect(authorizes(chain, '/haverstack/record/read', {})).toBe(true);
    expect(authorizes(chain, '/haverstack/record/delete', {})).toBe(false);
  });
});
