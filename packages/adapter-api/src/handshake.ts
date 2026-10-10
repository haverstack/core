/**
 * Challenge–response handshake
 * -------------------------------------------------------
 * Earning a bearer token by proving possession of a DID's key.
 * See docs/spec/wire-format.md § Authentication.
 */

import { buildAuthChallengePayload, base64urlEncode } from '@haverstack/core/wire';
import type { DidCredential } from '@haverstack/core/wire';
import { isWireAuthError, isRetryableAuthError } from '@haverstack/wire-types';
import type { WireAuthChallengeResponse, WireAuthTokenResponse } from '@haverstack/wire-types';
import { APIAdapterError, APIAdapterHandshakeError } from './errors.js';
import { fetchOrThrow, readJsonBody, successBody } from './transport.js';

/**
 * The typed error for a failed handshake step. An auth error body or a
 * 4xx refuses the credential; a bare 5xx is the server's own trouble, which
 * says nothing about the credential and may clear on a retry.
 */
const handshakeError = async (res: Response, path: string): Promise<Error> => {
  const body = await readJsonBody(res);
  if (isWireAuthError(body)) {
    return new APIAdapterHandshakeError(body.error.code, body.error.message);
  }
  const message = `HTTP ${res.status}: POST ${path}`;
  if (res.status >= 500) return new APIAdapterError(message, res.status);
  return new APIAdapterHandshakeError(undefined, message);
};

/**
 * Earn a bearer token by proving possession of the credential's key. The
 * signed payload binds the server's origin, so a server cannot relay a
 * challenge from the client's real stack and redeem the answer. A stale
 * nonce is retried once: losing the race between issuing and signing is
 * not a credential failure. See docs/spec/wire-format.md § Authentication.
 */
export const performHandshake = async (
  baseUrl: string,
  credential: DidCredential,
  allowRetry = true,
): Promise<WireAuthTokenResponse> => {
  const post = (path: string, body: unknown): Promise<Response> =>
    fetchOrThrow(baseUrl, `${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  const challengeRes = await post('/auth/challenge', { did: credential.did });
  if (!challengeRes.ok) throw await handshakeError(challengeRes, '/auth/challenge');
  const challenge = await successBody<WireAuthChallengeResponse>(
    challengeRes,
    'POST',
    '/auth/challenge',
  );

  const signature = await credential.sign(
    buildAuthChallengePayload({ origin: baseUrl, did: credential.did, nonce: challenge.nonce }),
  );

  const tokenRes = await post('/auth/token', {
    did: credential.did,
    nonce: challenge.nonce,
    signature: base64urlEncode(signature),
  });
  if (!tokenRes.ok) {
    const err = await handshakeError(tokenRes, '/auth/token');
    if (
      allowRetry &&
      err instanceof APIAdapterHandshakeError &&
      err.code &&
      isRetryableAuthError(err.code)
    ) {
      return performHandshake(baseUrl, credential, false);
    }
    throw err;
  }
  return successBody<WireAuthTokenResponse>(tokenRes, 'POST', '/auth/token');
};
