import type {
  WireAuthChallengeRequest,
  AuthChallengeResponse,
  WireAuthTokenRequest,
  AuthTokenResponse,
  WireAuthError,
} from '@haverstack/wire-types';
import type { ConformanceFixture, ConformanceSequenceFixture } from './types.js';

// The two endpoints that turn key possession into a bearer token
// (docs/spec/wire-format.md § Authentication). Unlike every other fixture
// in this package, these are unauthenticated by definition — they are how
// a token is obtained in the first place.
//
// The DID, nonce and signature below are real: the signature verifies
// against AUTH_FIXTURE_PAYLOAD, which is what @haverstack/core's
// buildAuthChallengePayload() produces for AUTH_FIXTURE_ORIGIN. A server
// consuming these must serve them from that origin, or the signature will
// correctly fail to verify — origin binding is the point, not an incidental
// detail of the fixture.

/** The origin these fixtures are signed for. A consuming server must present itself as this. */
export const AUTH_FIXTURE_ORIGIN = 'https://stack.example.com';

/** The DID whose key signed the handshake fixtures. */
export const AUTH_FIXTURE_DID = 'did:key:z6Mkfsz9oK6i2355mvEwtDYdAmqCN6kmQETThJtARfj9iGum';

export const AUTH_FIXTURE_NONCE = 'k7Qm2ZxRt9vLbNc4Hy8Wf3';

/** Exactly the bytes signed, as a string — so a consumer can diff against its own construction. */
export const AUTH_FIXTURE_PAYLOAD = `haverstack-auth-v1\n${AUTH_FIXTURE_ORIGIN}\n${AUTH_FIXTURE_DID}\n${AUTH_FIXTURE_NONCE}`;

/** base64url Ed25519 signature over AUTH_FIXTURE_PAYLOAD by AUTH_FIXTURE_DID's key. */
export const AUTH_FIXTURE_SIGNATURE =
  'CIvHvqS75hEpPDZi7hwLFOMM44-UCMuF5HzZ9_OIAMQvsGAYGsvXXpXQTP3KaPH2qKnQxl2j3xcB_v-axIx8Bg';

/** A well-formed signature over the same payload by a *different* key. */
export const AUTH_FIXTURE_FOREIGN_SIGNATURE =
  'qFvrpIE8dSPBO8-4QgFbS8jgs8dIz5XcqmqHX1GzFKrg6EnwNnc9vu2y8K1UHXKIUDo_NJgTj5B4xSGXUotiBg';

/** A second DID, holding its own key — for pinning that a nonce belongs to the DID it was issued for. */
export const AUTH_FIXTURE_OTHER_DID = 'did:key:z6Mktp5FtRqj2M7JxnPz9JWGMCUTE5o3XGt1br11TczKGp7B';

/** AUTH_FIXTURE_OTHER_DID's own valid signature over the same origin and nonce. */
export const AUTH_FIXTURE_OTHER_DID_SIGNATURE =
  'HV-vmd5p9cj6V4HjTUWLt1ySnFpp-hT4P_Lh_JXueTV8D992L4V-oEyL6koGY-kbkMB3ulJTLf7SYfnuXkXZDQ';

export const authChallengeFixtures: ConformanceFixture<
  WireAuthChallengeRequest,
  AuthChallengeResponse | WireAuthError
>[] = [
  {
    name: 'auth-challenge-issues-nonce',
    description:
      'POST /auth/challenge takes the DID a client wants to prove and returns a nonce bound to ' +
      'it, with the expiry the client can read rather than guess. Sent with no bearer token — ' +
      'this is how one is earned. The nonce is opaque but restricted to base64url characters, ' +
      'since it lands in a newline-delimited signing payload where an unconstrained value could ' +
      'span fields. It must be single-use and bound to the requested DID: a nonce redeemable ' +
      'twice, or with a different DID, is not a proof of anything.',
    method: 'POST',
    path: '/auth/challenge',
    requestBody: { did: AUTH_FIXTURE_DID },
    responseStatus: 200,
    responseBody: { nonce: AUTH_FIXTURE_NONCE, expiresAt: '2024-06-15T12:05:00.000Z' },
  },
  {
    name: 'auth-challenge-rejects-malformed-did',
    description:
      'A `did` that is not a DID at all is 400 / code "invalid_did" — malformed input rather ' +
      'than a rejected credential, since there is nothing here to authenticate yet. Auth codes ' +
      'are their own vocabulary, deliberately outside WireErrorCode: no Stack operation has ' +
      'begun, so none of them maps to a StackError.',
    method: 'POST',
    path: '/auth/challenge',
    requestBody: { did: 'not-a-did' },
    responseStatus: 400,
    responseBody: { error: { code: 'invalid_did', message: 'Not a valid DID' } },
  },
];

export const authTokenFixtures: ConformanceFixture<
  WireAuthTokenRequest,
  AuthTokenResponse | WireAuthError
>[] = [
  {
    name: 'auth-token-issues-bearer-token',
    description:
      'POST /auth/token redeems a signed nonce for a bearer token. The server verifies the ' +
      'signature against the payload it builds itself — never one supplied by the client — and ' +
      "that payload includes the server's own public origin, which is what stops a signature " +
      'made for one server being redeemed at another. principalId and subjectId are both ' +
      'reported and are equal here: a handshake proves key possession, which says nothing about ' +
      'whom that key may act for, so this endpoint never delegates. The pair is reported anyway ' +
      'so an issuance path that does delegate needs no different shape.',
    method: 'POST',
    path: '/auth/token',
    requestBody: {
      did: AUTH_FIXTURE_DID,
      nonce: AUTH_FIXTURE_NONCE,
      signature: AUTH_FIXTURE_SIGNATURE,
    },
    responseStatus: 200,
    responseBody: {
      token: 'a3f1c8e29b7d4056ab12cd34ef567890a3f1c8e29b7d4056ab12cd34ef567890',
      expiresAt: '2024-06-22T12:00:00.000Z',
      principalId: AUTH_FIXTURE_DID,
      subjectId: AUTH_FIXTURE_DID,
    },
  },
  {
    name: 'auth-token-rejects-foreign-signature',
    description:
      'A well-formed signature made by a key other than the one the DID names is 401 / code ' +
      '"invalid_signature". Fatal rather than retryable: repeating the handshake with the same ' +
      'credential reaches the same answer, so a client must stop rather than loop.',
    method: 'POST',
    path: '/auth/token',
    requestBody: {
      did: AUTH_FIXTURE_DID,
      nonce: AUTH_FIXTURE_NONCE,
      signature: AUTH_FIXTURE_FOREIGN_SIGNATURE,
    },
    responseStatus: 401,
    responseBody: { error: { code: 'invalid_signature', message: 'Signature does not verify' } },
  },
  {
    name: 'auth-token-rejects-expired-nonce',
    description:
      'A nonce past its expiry is 401 / code "expired_nonce". Retryable: the credential is ' +
      'fine and a fresh challenge will succeed, so a client re-runs the handshake once rather ' +
      'than surfacing a failure. Distinguishing this from invalid_signature is the whole reason ' +
      'these carry codes instead of being bodyless 401s like every other endpoint.',
    method: 'POST',
    path: '/auth/token',
    requestBody: {
      did: AUTH_FIXTURE_DID,
      nonce: AUTH_FIXTURE_NONCE,
      signature: AUTH_FIXTURE_SIGNATURE,
    },
    responseStatus: 401,
    responseBody: { error: { code: 'expired_nonce', message: 'Challenge has expired' } },
  },
  {
    name: 'auth-token-rejects-nonce-issued-to-another-did',
    description:
      'A nonce belongs to the DID it was issued for. This redemption is internally consistent — ' +
      'AUTH_FIXTURE_OTHER_DID signed this exact origin and nonce with its own key, so the ' +
      'signature verifies — and must still be refused with 401 / code "unknown_nonce", because ' +
      'the nonce was issued to AUTH_FIXTURE_DID. A server that stores nonces without recording ' +
      'who each was issued to passes every other fixture here and fails this one. Assumes the ' +
      'server has issued AUTH_FIXTURE_NONCE to AUTH_FIXTURE_DID and not yet spent it.',
    method: 'POST',
    path: '/auth/token',
    requestBody: {
      did: AUTH_FIXTURE_OTHER_DID,
      nonce: AUTH_FIXTURE_NONCE,
      signature: AUTH_FIXTURE_OTHER_DID_SIGNATURE,
    },
    responseStatus: 401,
    responseBody: { error: { code: 'unknown_nonce', message: 'Unknown or already-used nonce' } },
  },
  {
    name: 'auth-token-rejects-unknown-nonce',
    description:
      'A nonce the server never issued — or already spent, single use being what keeps a ' +
      'signature from being replayed — is 401 / code "unknown_nonce". Retryable for the same ' +
      'reason as expiry. A server MUST NOT distinguish never-issued from already-spent in the ' +
      'code it returns: the two differ only in what an attacker learns.',
    method: 'POST',
    path: '/auth/token',
    requestBody: {
      did: AUTH_FIXTURE_DID,
      nonce: 'Zz9NeverIssuedNonce00',
      signature: AUTH_FIXTURE_SIGNATURE,
    },
    responseStatus: 401,
    responseBody: { error: { code: 'unknown_nonce', message: 'Unknown or already-used nonce' } },
  },
];

/**
 * Single-use is the one handshake obligation no single request/response
 * pair can express, and it is the one whose absence is invisible: a server
 * that issues nonces, verifies signatures, and never spends them satisfies
 * every fixture above while letting one captured signature be redeemed for
 * as long as the nonce lives.
 */
export const authSequenceFixtures: ConformanceSequenceFixture[] = [
  {
    name: 'auth-nonce-is-single-use',
    description:
      'The same valid redemption sent twice: the first earns a token, the second is refused ' +
      'with 401 / code "unknown_nonce". The two requests are byte-identical — that is what makes ' +
      'this a replay rather than a differently-shaped request — so nothing about the second one ' +
      'distinguishes it except that the first already happened. A server must therefore spend ' +
      'the nonce when it redeems it, not merely check that it exists and has not expired. ' +
      'Assumes the server has issued AUTH_FIXTURE_NONCE to AUTH_FIXTURE_DID and not yet spent ' +
      'it. Note the refusal does not say "already used": never-issued and already-spent are ' +
      'deliberately indistinguishable, since they differ only in what an attacker learns.',
    steps: [
      {
        name: 'auth-nonce-is-single-use-first-redemption',
        description: 'The first redemption of a freshly issued nonce succeeds.',
        method: 'POST',
        path: '/auth/token',
        requestBody: {
          did: AUTH_FIXTURE_DID,
          nonce: AUTH_FIXTURE_NONCE,
          signature: AUTH_FIXTURE_SIGNATURE,
        },
        responseStatus: 200,
        responseBody: {
          token: 'a3f1c8e29b7d4056ab12cd34ef567890a3f1c8e29b7d4056ab12cd34ef567890',
          expiresAt: '2024-06-22T12:00:00.000Z',
          principalId: AUTH_FIXTURE_DID,
          subjectId: AUTH_FIXTURE_DID,
        },
      },
      {
        name: 'auth-nonce-is-single-use-replay-refused',
        description: 'The identical request again, after the nonce has been spent.',
        method: 'POST',
        path: '/auth/token',
        requestBody: {
          did: AUTH_FIXTURE_DID,
          nonce: AUTH_FIXTURE_NONCE,
          signature: AUTH_FIXTURE_SIGNATURE,
        },
        responseStatus: 401,
        responseBody: {
          error: { code: 'unknown_nonce', message: 'Unknown or already-used nonce' },
        },
      },
    ],
  },
];
