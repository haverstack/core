/**
 * Why a delegation was refused. Outside the StackError hierarchy, like
 * core's InvalidDidError: decoding and verifying a token begins no Stack
 * operation, so there is no wire code or status to carry.
 */
export type UcanErrorCode =
  /** Not a well-formed, canonically encoded UCAN Delegation 1.0 envelope. */
  | 'malformed'
  /** A signature algorithm, DID method or key type this package doesn't verify. */
  | 'unsupported'
  /** The signature does not verify against the issuer's key. */
  | 'signature'
  /** Outside a delegation's validity period. */
  | 'expired'
  | 'not-yet-valid'
  /** The chain does not link from its subject to its audience. */
  | 'misaligned'
  | 'revoked';

export class UcanError extends Error {
  readonly code: UcanErrorCode;

  constructor(code: UcanErrorCode, message: string) {
    super(message);
    this.name = 'UcanError';
    this.code = code;
  }
}
