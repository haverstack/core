/**
 * Delegations crossing between this package and iso-ucan, an independent
 * UCAN 1.0 implementation, in both directions: a misreading of the spec on
 * either side shows up as a token the other refuses.
 */

import { describe, expect, it } from 'vitest';
import { Delegation as IsoDelegation } from 'iso-ucan/delegation';
import { EdDSASigner } from 'iso-signatures/signers/eddsa.js';
import { ES256KSigner } from 'iso-signatures/signers/es256k.js';
import { Resolver } from 'iso-signatures/verifiers/resolver.js';
import { verifier as eddsa } from 'iso-signatures/verifiers/eddsa.js';
import { verifier as ecdsa } from 'iso-signatures/verifiers/ecdsa.js';
import { base58btc } from 'multiformats/bases/base58';
import { decodeDelegation, validateChain, authorizes } from '../src/index.js';
import { issue, makeSigner, NOW } from './helpers.js';

const isoSigners = {
  Ed25519: async () => EdDSASigner.generate(),
  ES256K: async () => ES256KSigner.generate(),
};

describe('iso-ucan interop', () => {
  it.each(Object.keys(isoSigners) as (keyof typeof isoSigners)[])(
    'verifies an iso-ucan %s delegation',
    async (alg) => {
      const signer = await isoSigners[alg]();
      const audience = makeSigner().did;
      const iso = await IsoDelegation.create({
        iss: signer,
        aud: audience,
        sub: signer.did,
        cmd: '/haverstack/read',
        pol: [['==', '.baseId', 'note']],
        exp: NOW + 60,
      } as never);
      const d = await decodeDelegation(iso.bytes);
      expect(d.cid).toBe(iso.cid.toString(base58btc));
      const chain = await validateChain([d], { now: NOW });
      expect(chain.audience).toBe(audience);
      expect(authorizes(chain, '/haverstack/read', { baseId: 'note' })).toBe(true);
    },
  );

  it.each(['Ed25519', 'ES256', 'ES256K'] as const)(
    'issues a %s delegation iso-ucan accepts',
    async (alg) => {
      const issuer = makeSigner(alg);
      const d = await issue(issuer, { cmd: '/haverstack/read', exp: NOW + 60 });
      const iso = await IsoDelegation.from({
        bytes: d.bytes,
        now: NOW,
        verifierResolver: new Resolver({ ...eddsa, ...ecdsa }),
      } as never);
      expect(iso.cid.toString(base58btc)).toBe(d.cid);
      expect(iso.cmd).toBe('/haverstack/read');
    },
  );
});
