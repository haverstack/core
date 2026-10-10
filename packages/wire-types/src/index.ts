/**
 * @haverstack/wire-types
 * -------------------------------------------------------
 * The HTTP wire format's shapes and the encodings between them and core's
 * types, shared by `@haverstack/adapter-api` and any server implementation
 * so both sides read the same contract. One module per endpoint group, the
 * same split `@haverstack/conformance-fixtures` uses. See
 * docs/spec/wire-format.md.
 */

export type {
  WireActor,
  WireRecord,
  WireQueryResponse,
  WireType,
  WireVersion,
  WireVersionsResponse,
} from './records.js';
export { serializeRecord, serializeType, serializeVersion } from './records.js';

export type { WireJournalEntry, WireJournalResponse } from './journal.js';
export { serializeJournalEntry } from './journal.js';

export type { WireErrorCode, WireError } from './errors.js';
export {
  WIRE_ERROR_STATUS,
  STATUS_TO_CODE,
  isWireError,
  serializeError,
  deserializeError,
  errorForStatus,
} from './errors.js';

export type { DiscoveryResponse, DiscoveryCapabilities } from './discovery.js';
export {
  WIRE_PROTOCOL_VERSION,
  normalizeCapabilities,
  parseProtocolVersion,
  isProtocolCompatible,
} from './discovery.js';

export type {
  DiscoveryAuth,
  AuthMethod,
  WireAuthChallengeRequest,
  WireAuthTokenRequest,
  AuthChallengeResponse,
  AuthTokenResponse,
  WireAuthErrorCode,
  WireAuthError,
} from './auth.js';
export {
  AUTH_METHOD_DID_CHALLENGE,
  supportsDidChallenge,
  WIRE_AUTH_ERROR_STATUS,
  isWireAuthError,
  isRetryableAuthError,
} from './auth.js';

export type {
  DiscoveryChanges,
  ChangeTransport,
  WireRecordChange,
  WireChangeActor,
  WireReadyFrame,
  ChangeResetReason,
  WireResetFrame,
} from './change-feed.js';
export {
  CHANGE_TRANSPORT_SSE,
  supportsChangeFeed,
  serializeChangeActor,
  serializeChange,
  CHANGE_FRAME_READY,
  CHANGE_FRAME_RECORD,
  CHANGE_FRAME_RESET,
  isValidCursor,
} from './change-feed.js';

export type { DiscoveryInstalls, WireInstallRequest, WireInstallResponse } from './installs.js';
export { supportsInstallRequests } from './installs.js';

/**
 * Re-exported from `@haverstack/core/wire`, which decodes wire dates on the
 * request side too — one definition, the same way `WireErrorCode` aliases
 * core's `StackErrorCode` rather than restating it.
 */
export { parseDate } from '@haverstack/core/wire';
