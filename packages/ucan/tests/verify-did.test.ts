import { describe, expect, it } from 'vitest';
import type { DidSignatureVerifier } from '@haverstack/core/wire';
import { buildAuthChallengePayload, verifyAuthChallenge } from '@haverstack/core/wire';
import { verifyDidKey } from '../src/index.js';
import { makeSigner } from './helpers.js';

// A server accepting delegations authenticates every key type it accepts
// as an issuer, so an app holding a P-256 or secp256k1 key can both be
// delegated to and complete the handshake as itself.
describe('verifyDidKey as the handshake verifier', () => {
  const verifyDid: DidSignatureVerifier = verifyDidKey;

  it.each(['Ed25519', 'ES256', 'ES256K'] as const)(
    'authenticates a %s did:key through verifyAuthChallenge',
    async (alg) => {
      const key = makeSigner(alg);
      const challenge = { origin: 'https://stack.example.com', did: key.did, nonce: 'n0nce' };
      const signature = await key.sign(buildAuthChallengePayload(challenge));
      await expect(verifyAuthChallenge(challenge, signature, { verifyDid })).resolves.toBe(true);
      await expect(
        verifyAuthChallenge({ ...challenge, nonce: 'other' }, signature, { verifyDid }),
      ).resolves.toBe(false);
    },
  );

  it('verifies nothing for another DID method or a bad key', async () => {
    await expect(
      verifyDidKey('did:web:example.com', new Uint8Array(64), Uint8Array.of(1)),
    ).resolves.toBe(false);
    await expect(
      verifyDidKey('did:key:zNotAKey', new Uint8Array(64), Uint8Array.of(1)),
    ).resolves.toBe(false);
  });
});
