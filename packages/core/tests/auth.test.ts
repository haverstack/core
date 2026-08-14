import { describe, test, expect } from 'vitest';
import {
  AUTH_PAYLOAD_LABEL,
  InvalidAuthChallengeError,
  authOriginFromUrl,
  buildAuthChallengePayload,
  signAuthChallenge,
  verifyAuthChallenge,
  didCredentialFromKeypair,
  base64urlEncode,
  base64urlDecode,
} from '../src/auth.js';
import { generateDidKeypair, verifyDidSignature } from '../src/did.js';
import type { DidKeypair } from '../src/did.js';

const ORIGIN = 'https://stack.example.com';
const NONCE = 'k7Qm2ZxRt9vLbNc4Hy8Wf3';

const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

let keypair: DidKeypair;
const getKeypair = async (): Promise<DidKeypair> => (keypair ??= await generateDidKeypair());

describe('authOriginFromUrl', () => {
  test('reduces a URL to scheme and host', () => {
    expect(authOriginFromUrl('https://stack.example.com/records/abc?x=1')).toBe(ORIGIN);
  });

  test('keeps a non-default port, which is part of what a signature is scoped to', () => {
    expect(authOriginFromUrl('http://localhost:8080/')).toBe('http://localhost:8080');
  });

  test('drops the default port for the scheme', () => {
    expect(authOriginFromUrl('https://stack.example.com:443')).toBe(ORIGIN);
  });

  test('lowercases the host, which URL syntax treats as case-insensitive', () => {
    expect(authOriginFromUrl('https://Stack.Example.COM')).toBe(ORIGIN);
  });

  test('refuses a URL with no origin to bind a signature to', () => {
    expect(() => authOriginFromUrl('data:text/plain,hello')).toThrow(InvalidAuthChallengeError);
  });

  test('refuses a string that is not a URL', () => {
    expect(() => authOriginFromUrl('stack.example.com')).toThrow(InvalidAuthChallengeError);
  });
});

describe('buildAuthChallengePayload', () => {
  test('is the documented label, origin, DID and nonce, newline-delimited', async () => {
    const { did } = await getKeypair();
    expect(decode(buildAuthChallengePayload({ origin: ORIGIN, did, nonce: NONCE }))).toBe(
      `${AUTH_PAYLOAD_LABEL}\n${ORIGIN}\n${did}\n${NONCE}`,
    );
  });

  test('normalizes the origin, so a client signs the same bytes whichever URL form it holds', async () => {
    const { did } = await getKeypair();
    const fromBare = buildAuthChallengePayload({ origin: ORIGIN, did, nonce: NONCE });
    const fromPath = buildAuthChallengePayload({
      origin: `${ORIGIN}/records?q=1`,
      did,
      nonce: NONCE,
    });
    expect(decode(fromPath)).toBe(decode(fromBare));
  });

  test('refuses a DID that is not one', () => {
    expect(() =>
      buildAuthChallengePayload({ origin: ORIGIN, did: 'not-a-did', nonce: NONCE }),
    ).toThrow(InvalidAuthChallengeError);
  });

  // The delimiter is a newline, so an unconstrained nonce could otherwise
  // close its own field and dictate the rest of the payload.
  test('refuses a nonce carrying a newline', async () => {
    const { did } = await getKeypair();
    expect(() =>
      buildAuthChallengePayload({ origin: ORIGIN, did, nonce: `abc\n${ORIGIN}\n${did}\nxyz` }),
    ).toThrow(InvalidAuthChallengeError);
  });

  test('refuses an empty nonce', async () => {
    const { did } = await getKeypair();
    expect(() => buildAuthChallengePayload({ origin: ORIGIN, did, nonce: '' })).toThrow(
      InvalidAuthChallengeError,
    );
  });
});

describe('signAuthChallenge / verifyAuthChallenge', () => {
  test('a signature verifies against the challenge it was made for', async () => {
    const kp = await getKeypair();
    const challenge = { origin: ORIGIN, did: kp.did, nonce: NONCE };
    expect(
      await verifyAuthChallenge(challenge, await signAuthChallenge(kp.privateKey, challenge)),
    ).toBe(true);
  });

  // The relay this binding exists to stop: a server a client connects to
  // fetches a challenge from the client's real stack, passes the nonce
  // along, and tries to redeem the answer there.
  test('a signature made for one origin does not verify at another', async () => {
    const kp = await getKeypair();
    const signature = await signAuthChallenge(kp.privateKey, {
      origin: 'https://impostor.example.net',
      did: kp.did,
      nonce: NONCE,
    });
    expect(
      await verifyAuthChallenge({ origin: ORIGIN, did: kp.did, nonce: NONCE }, signature),
    ).toBe(false);
  });

  test('a signature does not verify against a different nonce', async () => {
    const kp = await getKeypair();
    const signature = await signAuthChallenge(kp.privateKey, {
      origin: ORIGIN,
      did: kp.did,
      nonce: NONCE,
    });
    expect(
      await verifyAuthChallenge(
        { origin: ORIGIN, did: kp.did, nonce: 'DifferentNonce9' },
        signature,
      ),
    ).toBe(false);
  });

  test('a signature by another key does not verify for this DID', async () => {
    const kp = await getKeypair();
    const other = await generateDidKeypair();
    const challenge = { origin: ORIGIN, did: kp.did, nonce: NONCE };
    const signature = await signAuthChallenge(other.privateKey, {
      ...challenge,
      did: other.did,
    });
    expect(await verifyAuthChallenge(challenge, signature)).toBe(false);
  });

  // The caller asked whether it verifies; a key that cannot be decoded is a
  // "no", not an exception to handle separately.
  test('a DID whose key cannot be decoded verifies false rather than throwing', async () => {
    const kp = await getKeypair();
    const signature = await signAuthChallenge(kp.privateKey, {
      origin: ORIGIN,
      did: kp.did,
      nonce: NONCE,
    });
    expect(
      await verifyAuthChallenge(
        { origin: ORIGIN, did: 'did:web:example.com', nonce: NONCE },
        signature,
      ),
    ).toBe(false);
  });

  test('signs the payload the builder produces, not the bare nonce', async () => {
    const kp = await getKeypair();
    const challenge = { origin: ORIGIN, did: kp.did, nonce: NONCE };
    const signature = await signAuthChallenge(kp.privateKey, challenge);
    expect(await verifyDidSignature(kp.did, signature, new TextEncoder().encode(NONCE))).toBe(
      false,
    );
    expect(await verifyDidSignature(kp.did, signature, buildAuthChallengePayload(challenge))).toBe(
      true,
    );
  });
});

describe('didCredentialFromKeypair', () => {
  test('signs with the key behind its DID', async () => {
    const kp = await getKeypair();
    const credential = didCredentialFromKeypair(kp);
    const challenge = { origin: ORIGIN, did: credential.did, nonce: NONCE };
    const signature = await credential.sign(buildAuthChallengePayload(challenge));
    expect(credential.did).toBe(kp.did);
    expect(await verifyAuthChallenge(challenge, signature)).toBe(true);
  });
});

describe('base64url', () => {
  test('round-trips arbitrary bytes', () => {
    const bytes = new Uint8Array([0, 1, 62, 63, 127, 128, 254, 255]);
    expect(base64urlDecode(base64urlEncode(bytes))).toEqual(bytes);
  });

  test('round-trips a signature, the payload it exists for', async () => {
    const kp = await getKeypair();
    const signature = await signAuthChallenge(kp.privateKey, {
      origin: ORIGIN,
      did: kp.did,
      nonce: NONCE,
    });
    expect(base64urlDecode(base64urlEncode(signature))).toEqual(signature);
  });

  test('emits no padding or non-URL-safe characters', () => {
    const encoded = base64urlEncode(new Uint8Array([251, 255, 190, 255, 0]));
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  test('refuses input outside the base64url alphabet', () => {
    expect(() => base64urlDecode('not/valid+base64url==')).toThrow(InvalidAuthChallengeError);
  });
});
