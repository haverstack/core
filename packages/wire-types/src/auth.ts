/**
 * Authentication handshake
 * -------------------------------------------------------
 * How a server advertises token issuance, the challenge–response bodies,
 * and the handshake's own error vocabulary.
 * See docs/spec/wire-format.md § Authentication.
 */

import { hasErrorBody } from './errors.js';

/**
 * How a token can be earned here. Absent means only a scheme arranged out
 * of band, which a client learns at open() rather than as a 404 partway
 * through a handshake. An object so a consent flow can arrive as another
 * entry. See docs/spec/wire-format.md § Advertising it.
 */
export type DiscoveryAuth = {
  methods: AuthMethod[];
};

/** The challenge–response handshake of docs/spec/wire-format.md § Authentication. */
export const AUTH_METHOD_DID_CHALLENGE = 'did-challenge';

export type AuthMethod = typeof AUTH_METHOD_DID_CHALLENGE;

/** Whether a server advertises the DID challenge–response handshake. */
export function supportsDidChallenge(discovery: { auth?: DiscoveryAuth }): boolean {
  return discovery.auth?.methods?.includes(AUTH_METHOD_DID_CHALLENGE) ?? false;
}

/**
 * The two request bodies, re-exported from `@haverstack/core/wire`, whose
 * parsers return them — one definition, as with `parseDate`.
 */
export type { WireAuthChallengeRequest, WireAuthTokenRequest } from '@haverstack/core/wire';

/** POST /auth/challenge response. */
export type AuthChallengeResponse = {
  /** Opaque, single-use, base64url-charset. Bound to the requested DID. */
  nonce: string;
  expiresAt: string;
};

/**
 * POST /auth/token response. Both identities are always present, and this
 * endpoint always reports them equal — a handshake proves key possession,
 * which says nothing about whom that key may act for. The pair is reported
 * anyway so an issuance path that does delegate needs no new shape.
 * See docs/spec/wire-format.md § Authentication.
 */
export type AuthTokenResponse = {
  token: string;
  expiresAt?: string;
  principalId: string;
  subjectId: string;
};

/**
 * Auth failures have their own vocabulary, deliberately outside
 * WireErrorCode: no Stack operation has begun, so none of them is a
 * StackError and none has a class to reconstruct. The split a client acts
 * on is retryable versus fatal — a stale nonce warrants a fresh handshake,
 * a rejected signature never will.
 */
export type WireAuthErrorCode =
  | 'invalid_did'
  | 'unknown_nonce'
  | 'expired_nonce'
  | 'invalid_signature';

export type WireAuthError = {
  error: {
    code: WireAuthErrorCode;
    message: string;
  };
};

export const WIRE_AUTH_ERROR_STATUS: Record<WireAuthErrorCode, number> = {
  // Malformed input, not a rejected credential — there is nothing here to
  // authenticate yet.
  invalid_did: 400,
  unknown_nonce: 401,
  expired_nonce: 401,
  invalid_signature: 401,
};

/** Codes a fresh handshake can resolve. Anything else is fatal to retry. */
const RETRYABLE_AUTH_CODES = new Set<WireAuthErrorCode>(['unknown_nonce', 'expired_nonce']);

const KNOWN_AUTH_CODES = new Set<string>(Object.keys(WIRE_AUTH_ERROR_STATUS));

/** Type guard: does this parsed JSON body look like a WireAuthError? */
export function isWireAuthError(body: unknown): body is WireAuthError {
  return hasErrorBody(body, KNOWN_AUTH_CODES);
}

/** Whether retrying the handshake from a fresh nonce could succeed. */
export function isRetryableAuthError(code: WireAuthErrorCode): boolean {
  return RETRYABLE_AUTH_CODES.has(code);
}
