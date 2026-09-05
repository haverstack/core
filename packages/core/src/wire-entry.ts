/**
 * @haverstack/core/wire
 * -------------------------------------------------------
 * The request encoding, the handshake and the attachment-download policy
 * shared by both sides of a client/server connection — building a payload
 * identically on both ends is the whole point, so this is imported by
 * clients (e.g. adapter-api) and servers alike. The request encoding is
 * carried here as both halves: adapter-api builds a query, and the parsers
 * below decode it, so a server inherits the grammar rather than
 * transcribing it. See docs/spec/wire-format.md.
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

// No in-repo caller: the parse half of the request encoding adapter-api
// builds, so a server decodes GET /records, POST /records/query and
// GET /changes with these rather than transcribing the parameter table.
// Contract, not internal — and the round trip against the builders is
// pinned by a test, which is what having both halves here buys.
export {
  parseQueryParams,
  parseQueryBody,
  parseChangeParams,
  parseIfMatch,
  parseUploadFilename,
  parsePositiveInt,
} from './wire-request.js';
export type { ParsedChangeParams } from './wire-request.js';

// Re-exported by @haverstack/wire-types for the response side: one wire
// date decoding, used by both halves.
export { parseDate } from './wire-request.js';

// Thrown by every parser above on malformed input, which a server maps to
// 400 — already exported from @haverstack/core, and named here so the wire
// entry point stands alone. See docs/spec/wire-format.md § Error responses.
export { StackQueryError } from './stack.js';

// Thrown alongside it by createOptionsFromWireRecord() below, which maps to
// 422 and carries the field path that distinction exists to report.
export { StackValidationError } from './stack.js';

// No in-repo caller: the create half of the same contract, so a server
// inherits which half of a record body it may trust rather than deciding
// field by field. See docs/spec/wire-format.md § Records.
export { createOptionsFromWireRecord } from './wire-record.js';
export type { WireCreateRequest } from './wire-record.js';

// The tier gating hard delete, commitMigration() and includeUnlisted, which
// a server must decide for those routes itself. Computing it as "is the
// owner" is a privilege bug with no symptom.
export { isOwnerActingAlone } from './access.js';
