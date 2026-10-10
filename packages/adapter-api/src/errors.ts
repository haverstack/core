/**
 * Error types
 * -------------------------------------------------------
 * Everything this adapter throws of its own, rooted at APIAdapterError so
 * a caller can catch the whole family in one clause. Errors the server
 * reports travel as core's StackError subclasses instead.
 */

import type { MissingCapability } from '@haverstack/core';
import type { WireAuthErrorCode } from '@haverstack/wire-types';

export class APIAdapterError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
  ) {
    super(message);
    this.name = 'APIAdapterError';
  }
}

export class APIAdapterAuthError extends APIAdapterError {
  constructor(message = 'Unauthorized: invalid or missing token') {
    super(message, 401);
    this.name = 'APIAdapterAuthError';
  }
}

export class APIAdapterConnectionError extends APIAdapterError {
  constructor(url: string, cause?: unknown) {
    super(`Could not reach server at "${url}"`);
    this.name = 'APIAdapterConnectionError';
    if (cause) this.cause = cause;
  }
}

/**
 * Thrown locally — before any request is sent — when a query uses a
 * filter the connected server has declared it doesn't support. Sending it
 * anyway would return an unfiltered superset presented as the filtered
 * result. See docs/spec/wire-format.md § Records.
 */
export class APIAdapterCapabilityError extends APIAdapterError {
  constructor(
    /**
     * `'changes'` names the feed and `'installs'` the install endpoint,
     * which discovery advertises beside `capabilities` rather than in it.
     */
    public readonly capability: MissingCapability | 'changes' | 'installs',
    message: string,
  ) {
    super(message);
    this.name = 'APIAdapterCapabilityError';
  }
}

/**
 * Thrown by open() when the server's protocol major differs from this
 * client's, or when discovery reports no parseable version at all. Refusing
 * at the door beats the alternative: a major difference means some response
 * reads wrongly, and finding out mid-session leaves the caller unsure which
 * writes landed. See docs/spec/wire-format.md § Version negotiation.
 */
export class APIAdapterVersionError extends APIAdapterError {
  constructor(
    public readonly serverVersion: string | undefined,
    message: string,
  ) {
    super(message);
    this.name = 'APIAdapterVersionError';
  }
}

/**
 * Thrown when the handshake itself is rejected — the server accepted the
 * request and refused the credential. `code` distinguishes a stale nonce,
 * which another handshake resolves, from a rejected signature, which no
 * number of retries will. See docs/spec/wire-format.md § Authentication.
 */
export class APIAdapterHandshakeError extends APIAdapterAuthError {
  constructor(
    public readonly code: WireAuthErrorCode | undefined,
    message: string,
  ) {
    super(message);
    this.name = 'APIAdapterHandshakeError';
  }
}

/**
 * Thrown when a request came back 401 and re-authenticating did not
 * recover it. Distinguishable from APIAdapterAuthError, which means the
 * token was never good: this one means a session ended and could not be
 * renewed, so the credential — not the request — is what to look at.
 */
export class APIAdapterReauthError extends APIAdapterAuthError {
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'APIAdapterReauthError';
    if (cause) this.cause = cause;
  }
}

/**
 * Thrown by open() for a plaintext `http://` URL to a non-loopback host
 * without `allowInsecure`. See APIAdapterOpenOptions.allowInsecure.
 */
export class APIAdapterInsecureUrlError extends APIAdapterError {
  constructor(public readonly url: string) {
    super(
      `Refusing to open a plaintext connection to "${url}": the bearer token, the ` +
        `handshake signature and every record would travel in the clear. Use https://, ` +
        `or pass { allowInsecure: true } if the transport is already private.`,
    );
    this.name = 'APIAdapterInsecureUrlError';
  }
}

/**
 * Thrown by open() when a credential was supplied and the server does not
 * advertise the handshake. Refusing here beats a 404 from the first
 * /auth/challenge: nothing this client can do will authenticate it, and
 * discovery already said so.
 */
export class APIAdapterAuthUnsupportedError extends APIAdapterError {
  constructor(message: string) {
    super(message);
    this.name = 'APIAdapterAuthUnsupportedError';
  }
}
