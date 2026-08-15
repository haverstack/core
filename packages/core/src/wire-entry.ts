/**
 * @haverstack/core/wire
 * -------------------------------------------------------
 * The handshake and attachment-download policy shared by both sides of a
 * client/server connection — building a payload identically on both ends is
 * the whole point, so this is imported by clients (e.g. adapter-api) and
 * servers alike. See docs/spec/wire-format.md.
 */

export {
  buildAuthChallengePayload,
  signAuthChallenge,
  verifyAuthChallenge,
  didCredentialFromKeypair,
  base64urlEncode,
  base64urlDecode,
} from './auth.js';
export type { AuthChallenge, DidCredential } from './auth.js';

// No in-repo caller: a server must derive the signing origin from its own
// configured public origin (haverstack/server#53) — this is the primitive
// it does that with.
export { authOriginFromUrl } from './auth.js';

// Thrown by authOriginFromUrl, buildAuthChallengePayload and
// base64urlDecode above — all public, so a caller needs this to
// distinguish malformed input from any other Error.
export { InvalidAuthChallengeError } from './auth.js';

export {
  isSafeAttachmentContentType,
  inferContentTypeFromFilename,
  resolveAttachmentDownloadContentType,
  NOSNIFF_HEADER_NAME,
  NOSNIFF_HEADER_VALUE,
} from './attachment-download.js';
export type { AttachmentDownloadContentType } from './attachment-download.js';

// No in-repo caller: resolveAttachmentDownloadContentType() takes
// storedMimeType as an input rather than selecting the record itself — a
// server must call this to apply the earliest-createdAt/lowest-id total
// order and pass the winner in. Contract, not internal. haverstack/server#37
export { firstRecordedAttachment } from './attachment-download.js';

// Server-facing: bearer-token issuance and lookup, backed by its own file
// outside the portable stack database — not a slot on StackAdapter.
export type { StackTokenStore, TokenInfo } from './types.js';
