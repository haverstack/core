/**
 * Stack — API Adapter
 * -------------------------------------------------------
 * Implements StackAdapter over HTTP. On open(), calls the
 * discovery endpoint to populate AdapterCapabilities before
 * returning, so capabilities are available synchronously
 * once the adapter is in hand.
 *
 * Authentication uses a bearer token in the Authorization header. A token
 * is either handed in (`token`) or earned by proving key possession
 * against a DID (`credential`) — see docs/spec/wire-format.md
 * § Authentication.
 *
 * v1 requires connectivity — offline queue is deferred. Opt-in
 * optimistic concurrency (ifVersion → If-Match) is supported: see the
 * expectedVersion option on mutateRecord(), deleteRecord() and every
 * other mutation that bumps a version.
 *
 * The write options that describe storage rather than the request are
 * omitted from the methods below rather than dropped inside them, so the
 * signature says what travels: the server writes its own version snapshot
 * and its own journal entry from the change it applies, and decides its
 * own version bump the same way. See docs/spec/versioning.md § Storage per
 * adapter.
 */

import { StackError, StackBadRequestError } from '@haverstack/core';
import type {
  JournalQuery,
  RecordJournalEntry,
  StackAdapter,
  Actor,
  ChangeActor,
  StackRecord,
  PutAttachmentOptions,
  StackType,
  TypeSchema,
  TypeId,
  RecordVersion,
  StackQuery,
  QueryResult,
  Association,
  RecordId,
  FileId,
  EntityId,
  ChangeFilter,
  RecordFilter,
  RecordChange,
  RecordChangeSet,
} from '@haverstack/core';
import {
  assertQueryCapabilities,
  assertSortCapability,
  assertValidRelatedTo,
  filtersContent,
} from '@haverstack/core/adapter';
import type {
  AdapterCapabilities,
  MissingCapability,
  SubscribeChangesOptions,
} from '@haverstack/core/adapter';
import {
  assertQueryTravels,
  buildAuthChallengePayload,
  base64urlEncode,
} from '@haverstack/core/wire';
import type { DidCredential } from '@haverstack/core/wire';
import type {
  WireActor,
  WireChangeActor,
  WireRecord,
  WireQueryResponse,
  WireType,
  WireVersion,
  WireRecordChange,
  WireJournalEntry,
  WireJournalResponse,
  DiscoveryChanges,
  DiscoveryResponse,
  AuthChallengeResponse,
  AuthTokenResponse,
  WireAuthErrorCode,
} from '@haverstack/wire-types';
import {
  isWireError,
  deserializeError,
  errorForStatus,
  isProtocolCompatible,
  isWireAuthError,
  isRetryableAuthError,
  isValidSeq,
  supportsChangeFeed,
  WIRE_ERROR_STATUS,
  supportsDidChallenge,
  CHANGE_FRAME_READY,
  CHANGE_FRAME_RECORD,
  CHANGE_FRAME_RESET,
  WIRE_PROTOCOL_VERSION,
  normalizeCapabilities,
} from '@haverstack/wire-types';

// -------------------------------------------------------
// Public option types
// -------------------------------------------------------

/**
 * Re-exported because APIAdapterCapabilityError carries one: a caller
 * narrowing on `capability` reads the name from here rather than from a
 * second package. Core owns the definition, next to the capabilities it
 * names.
 */
export type { MissingCapability } from '@haverstack/core/adapter';

export type APIAdapterOpenOptions = {
  /** Base URL of the stack server e.g. "https://example.com". Trailing slash is stripped. */
  url: string;
  /** Bearer token issued by the stack server. Omit for unauthenticated access. */
  token?: string;
  /**
   * The DID this client expects to own the stack at `url`. When set, open()
   * refuses a server whose discovery reports anything else. Omit when the URL
   * is the only expectation you have.
   */
  expectedOwner?: EntityId;
  /**
   * A DID and a signing callback — never a private key. open() performs the
   * challenge–response handshake with it and re-runs that handshake when a
   * token expires, so callers never handle token lifecycle themselves.
   * Mutually exclusive with `token`.
   */
  credential?: DidCredential;
  /**
   * Permit a plaintext `http://` URL to a host that isn't loopback. Off by
   * default: everything this adapter carries — a bearer token, a signed
   * handshake, and the stack's contents — is readable and rewritable by
   * anything on the path. Loopback needs no flag, so local development and
   * a sidecar server are unaffected.
   */
  allowInsecure?: boolean;
};

// -------------------------------------------------------
// Error types
// -------------------------------------------------------

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
     * `'changes'` names the feed, which discovery advertises beside
     * `capabilities` rather than in it.
     */
    public readonly capability: MissingCapability | 'changes',
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
 * Thrown by open() when `expectedOwner` was supplied and discovery reports a
 * different owner — or none at all. Discovery identity is unsigned and the
 * server cannot prove it, so stating the DID you expect is the only check
 * available to a client. See docs/spec/wire-format.md § Identity is trusted
 * on transport.
 */
export class APIAdapterOwnerMismatchError extends APIAdapterError {
  constructor(
    public readonly expectedOwner: EntityId,
    public readonly actualOwner: EntityId | undefined,
    message: string,
  ) {
    super(message);
    this.name = 'APIAdapterOwnerMismatchError';
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

// -------------------------------------------------------
// Transport helpers
// -------------------------------------------------------

/**
 * Whether a URL's host is the local machine, where plaintext has no
 * network to be observed on. Matched by host rather than by name
 * resolution: a name that merely resolves to a loopback address today is
 * not a promise about where the next request goes.
 */
const isLoopbackUrl = (url: string): boolean => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return host === 'localhost' || host === '::1' || /^127\.\d+\.\d+\.\d+$/.test(host);
};

/**
 * fetch(), with a transport failure reported as this adapter's own error.
 * `baseUrl` names the server in the message even when `url` is a longer
 * path under it — what failed is the connection, not the endpoint.
 */
const fetchOrThrow = async (
  baseUrl: string,
  url: string,
  init?: RequestInit,
): Promise<Response> => {
  try {
    return await fetch(url, init);
  } catch (err) {
    throw new APIAdapterConnectionError(baseUrl, err);
  }
};

/**
 * The headers every request carries: the bearer token when there is one —
 * an unauthenticated adapter sends no empty `Bearer` — plus whatever the
 * endpoint adds.
 */
const authHeaders = (
  token: string | undefined,
  extra?: Record<string, string>,
): Record<string, string> => {
  const headers: Record<string, string> = { ...extra };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return headers;
};

/**
 * A response body as JSON, or undefined when there is none to read. For
 * error paths only: a failed response is under no obligation to carry a
 * parseable body, and the status still has to be reported when it doesn't.
 */
const readJsonBody = async (res: Response): Promise<unknown> => {
  try {
    return await res.json();
  } catch {
    return undefined;
  }
};

/**
 * The head of an unparseable body: enough to recognize what answered,
 * without pasting a whole error page into an exception message.
 */
const bodyExcerpt = (text: string, limit = 120): string => {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > limit ? `${collapsed.slice(0, limit)}…` : collapsed;
};

/**
 * The body of a successful response, or `undefined` when it carried none
 * — which only the call site can judge. A non-empty body that will not
 * parse is the server's fault wherever it lands, so it is reported here.
 * See docs/spec/wire-format.md § Success responses.
 */
const parseJsonBody = async (res: Response, method: string, path: string): Promise<unknown> => {
  const text = await res.text();
  if (text.trim() === '') return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw new APIAdapterError(
      `${method} ${path} answered ${res.status} with a body that is not JSON. ` +
        `The response began: ${bodyExcerpt(text)}`,
      res.status,
    );
  }
};

// -------------------------------------------------------
// Domain object parsers (wire JSON → typed domain objects)
// -------------------------------------------------------
//
// Responses only. This adapter is a client: it never reads a request body,
// so the identity fields a server assigns from the session — createdBy and
// updatedBy — arrive already decided, and parsing
// them is reading an answer rather than accepting a claim.
// See docs/spec/wire-format.md § Records.

const parseActor = (raw: WireActor): Actor => ({
  subjectId: raw.subjectId,
  ...(raw.principalId != null && { principalId: raw.principalId }),
});

const parseChangeActor = (raw: WireChangeActor): ChangeActor => ({
  ...parseActor(raw),
  ...(raw.appId != null && { appId: raw.appId }),
});

const parseRecord = (raw: WireRecord): StackRecord => {
  const record: StackRecord = {
    id: raw.id,
    typeId: raw.typeId,
    createdAt: new Date(raw.createdAt),
    updatedAt: new Date(raw.updatedAt),
    content: raw.content,
    version: raw.version,
  };
  if (raw.parentId != null) record.parentId = raw.parentId;
  if (raw.appId != null) record.appId = raw.appId;
  if (raw.createdBy != null) record.createdBy = parseActor(raw.createdBy);
  if (raw.updatedBy != null) record.updatedBy = parseActor(raw.updatedBy);
  if (raw.deletedAt != null) record.deletedAt = new Date(raw.deletedAt);
  if (raw.unlistedAt != null) record.unlistedAt = new Date(raw.unlistedAt);
  if (raw.permissions != null) record.permissions = raw.permissions;
  if (raw.associations != null) record.associations = raw.associations;
  return record;
};

/**
 * A Record body a mutation is required to answer with. Every mutation that
 * bumps `version` returns one, so an empty body is a foreign server that
 * has not implemented the current wire format — reported as such rather
 * than as a property access on `undefined`.
 * See docs/spec/wire-format.md § Records.
 */
const requireRecordBody = (raw: WireRecord | undefined, endpoint: string): StackRecord => {
  if (!raw) {
    throw new APIAdapterError(
      `${endpoint} answered with no Record body. Every mutation that bumps a version must ` +
        'return the record it produced.',
    );
  }
  return parseRecord(raw);
};

const emptyBodyError = (endpoint: string): APIAdapterError =>
  new APIAdapterError(
    `${endpoint} answered with no body. A 200 carries the body its endpoint returns; ` +
      'an absent record, version or type is a 404.',
  );

/**
 * The body a read with no "absent" case is owed, reported rather than
 * dereferenced when it is missing.
 * See docs/spec/wire-format.md § Success responses.
 */
const requireBody = <T>(raw: T | null | undefined, endpoint: string): T => {
  if (raw == null) throw emptyBodyError(endpoint);
  return raw;
};

/**
 * The same, for a read that can answer "not there": only the `null` this
 * adapter produced from a `404` travels, never an empty body.
 * See docs/spec/wire-format.md § Success responses.
 */
const requireNullableBody = <T>(raw: T | null | undefined, endpoint: string): T | null => {
  if (raw === undefined) throw emptyBodyError(endpoint);
  return raw;
};

const parseType = (raw: WireType): StackType => {
  const t: StackType = {
    id: raw.id,
    baseId: raw.baseId,
    version: raw.version,
    name: raw.name,
    schema: raw.schema as TypeSchema,
    schemaHash: raw.schemaHash,
    createdAt: new Date(raw.createdAt),
  };
  if (raw.migratesFrom != null) t.migratesFrom = raw.migratesFrom;
  return t;
};

const parseVersion = (raw: WireVersion): RecordVersion => {
  const v: RecordVersion = {
    version: raw.version,
    typeId: raw.typeId,
    content: raw.content,
    updatedAt: new Date(raw.updatedAt),
  };
  if (raw.createdBy != null) v.createdBy = parseActor(raw.createdBy);
  if (raw.updatedBy != null) v.updatedBy = parseActor(raw.updatedBy);
  return v;
};

/**
 * `previousParentId` is the one field read for presence rather than for
 * null: absent means this entry is not a reparent, while `null` means the
 * record moved out of the root. Every other nullable field on a response
 * collapses both to absent, which here would lose which one happened.
 */
const parseJournalEntry = (raw: WireJournalEntry): RecordJournalEntry => {
  const e: RecordJournalEntry = {
    seq: raw.seq,
    at: new Date(raw.at),
    kind: raw.kind,
    ops: [...raw.ops],
    version: raw.version,
    typeId: raw.typeId,
  };
  if (raw.parentId != null) e.parentId = raw.parentId;
  if (raw.actor != null) e.actor = parseChangeActor(raw.actor);
  if (raw.previousParentId !== undefined) e.previousParentId = raw.previousParentId;
  if (raw.associations != null) e.associations = raw.associations;
  return e;
};

// -------------------------------------------------------
// Query parameter builder (used when the server reaches no content)
// -------------------------------------------------------

/**
 * A filter field naming one value or many travels as repeats of a single
 * parameter, so the server reads one shape either way.
 */
const appendEach = (p: URLSearchParams, name: string, value: string | string[]): void => {
  for (const v of Array.isArray(value) ? value : [value]) p.append(name, v);
};

/**
 * `null` names the root, which has to be spelled rather than omitted: an
 * absent parameter asks for records at any depth.
 */
const setParentId = (p: URLSearchParams, parentId: string | null): void => {
  p.set('parentId', parentId === null ? 'null' : parentId);
};

/** The author filter, spelled the same on `GET /records` and `GET /changes`. */
const appendCreatedBy = (p: URLSearchParams, createdBy: RecordFilter['createdBy']): void => {
  if (createdBy?.subjectId !== undefined) appendEach(p, 'createdBySubject', createdBy.subjectId);
  if (createdBy?.principalId !== undefined)
    appendEach(p, 'createdByPrincipal', createdBy.principalId);
};

const buildQueryParams = (query: StackQuery): URLSearchParams => {
  const p = new URLSearchParams();
  const f = query.filter ?? {};

  if (f.typeId !== undefined) appendEach(p, 'typeId', f.typeId);
  if (f.parentId !== undefined) setParentId(p, f.parentId);
  if (f.appId !== undefined) appendEach(p, 'appId', f.appId);
  appendCreatedBy(p, f.createdBy);
  if (f.createdAt?.before) p.set('createdBefore', f.createdAt.before.toISOString());
  if (f.createdAt?.after) p.set('createdAfter', f.createdAt.after.toISOString());
  if (f.updatedAt?.before) p.set('updatedBefore', f.updatedAt.before.toISOString());
  if (f.updatedAt?.after) p.set('updatedAfter', f.updatedAt.after.toISOString());
  if (f.tags) for (const tag of f.tags) p.append('tag', tag);
  if (f.hasAttachment) p.set('hasAttachment', f.hasAttachment);
  if (f.attachmentFileId) p.set('attachmentFileId', f.attachmentFileId);
  if (f.relatedTo) {
    // The target kind is implied by which qualifier appears, and the type
    // guarantees at least one of these branches sets something — so the
    // filter can never encode to nothing and silently widen the query.
    // The server rejects a mix of kinds.
    const t = f.relatedTo.target;
    if (t?.kind === 'record') {
      p.set('relatedTo', t.recordId);
      if (t.stackUrl !== undefined) p.set('relatedToStack', t.stackUrl);
    } else if (t?.kind === 'entity') {
      p.set('relatedToEntity', t.entityId);
    } else if (t?.kind === 'external') {
      p.set('relatedToNs', t.ns);
      if (t.id !== undefined) p.set('relatedToId', t.id);
    }
    if (f.relatedTo.label !== undefined) p.set('relatedToLabel', f.relatedTo.label);
  }
  if (f.search) p.set('search', f.search);
  if (f.includeDeleted) p.set('includeDeleted', 'true');
  if (f.includeUnlisted) p.set('includeUnlisted', 'true');
  // Which parameter carries the name is what says whether it names a
  // native column or a content field — the same "kind implied by the
  // parameter" shape the relationship filter uses above.
  if (query.sort?.contentField) p.set('sortContent', query.sort.contentField);
  if (query.sort?.field) p.set('sort', query.sort.field);
  if (query.sort?.direction) p.set('direction', query.sort.direction);
  if (query.limit) p.set('limit', String(query.limit));
  if (query.cursor) p.set('cursor', query.cursor);

  return p;
};

// -------------------------------------------------------
// Change feed
// -------------------------------------------------------

const parseChange = (raw: WireRecordChange): RecordChange => {
  const change: RecordChange = {
    kind: raw.kind,
    // Copied, so a frame's array is never shared with the parsed change a
    // handler receives.
    ops: [...raw.ops],
    recordId: raw.recordId,
    typeId: raw.typeId,
    version: raw.version,
    updatedAt: new Date(raw.updatedAt),
  };
  if (raw.actor != null) change.actor = parseChangeActor(raw.actor);
  if (raw.seq != null) change.seq = raw.seq;
  // A purge carries nothing about the record it destroyed. A conformant
  // server sends neither field on one; dropping them here means a server
  // that does cannot hand a subscriber the copy the verb exists to erase.
  if (raw.kind === 'purged') return change;
  if (raw.parentId != null) change.parentId = raw.parentId;
  if (raw.associationsAdded != null) change.associationsAdded = raw.associationsAdded;
  if (raw.associationsRemoved != null) change.associationsRemoved = raw.associationsRemoved;
  if (raw.record != null) change.record = parseRecord(raw.record);
  return change;
};

const buildChangeParams = (opts: SubscribeChangesOptions): URLSearchParams => {
  const p = new URLSearchParams();
  const f: ChangeFilter = opts.filter ?? {};

  if (f.typeId !== undefined) appendEach(p, 'typeId', f.typeId);
  if (f.baseId !== undefined) appendEach(p, 'baseId', f.baseId);
  if (f.parentId !== undefined) setParentId(p, f.parentId);
  appendCreatedBy(p, f.createdBy);
  if (f.kinds !== undefined) for (const kind of f.kinds) p.append('kind', kind);
  if (opts.includeRecords) p.set('include', 'record');
  if (opts.includeUnlisted) p.set('includeUnlisted', 'true');

  return p;
};

/** One decoded SSE frame. `event` defaults to the protocol's own default. */
type SseFrame = { id?: string; event: string; data: string };

/**
 * Incremental SSE decoder: text in, whole frames out, holding a partial
 * frame until the blank line that ends it. Chunk boundaries fall wherever
 * the network puts them, so a frame arriving in three pieces has to
 * decode identically to one arriving whole.
 */
class SseDecoder {
  private buffer = '';
  /**
   * A trailing `\r` held back from normalization. SSE line endings are CR,
   * LF, or CRLF, and a chunk boundary can fall between the CR and the LF of
   * a CRLF: normalizing per chunk would turn that lone CR into a `\n` and
   * the next chunk's leading `\n` would complete a spurious `\n\n`, cutting
   * one frame into two. Holding the CR until the next chunk decides whether
   * it is half a CRLF (drop the following `\n`) or a lone CR (its own line
   * separator) makes a frame split anywhere decode as one arriving whole.
   */
  private pendingCr = false;

  push(chunk: string): SseFrame[] {
    let text = this.pendingCr ? '\r' + chunk : chunk;
    this.pendingCr = false;
    // A trailing CR might be the first half of a CRLF split across chunks;
    // hold it until the next push (or the stream's end) resolves it.
    if (text.endsWith('\r')) {
      this.pendingCr = true;
      text = text.slice(0, -1);
    }
    this.buffer += text.replace(/\r\n|\r/g, '\n');
    // A frame with no terminating blank line grows the buffer without
    // bound; a peer that never closes one would otherwise exhaust memory.
    if (this.buffer.length > MAX_SSE_BUFFER_BYTES) {
      throw new APIAdapterError(
        `Change feed frame exceeded ${MAX_SSE_BUFFER_BYTES} bytes without a frame boundary.`,
      );
    }
    const frames: SseFrame[] = [];
    let boundary = this.buffer.indexOf('\n\n');
    while (boundary !== -1) {
      const block = this.buffer.slice(0, boundary);
      this.buffer = this.buffer.slice(boundary + 2);
      const frame = decodeFrame(block);
      if (frame) frames.push(frame);
      boundary = this.buffer.indexOf('\n\n');
    }
    return frames;
  }
}

/**
 * How large a single unterminated SSE frame may grow before the connection
 * is abandoned. Generous next to any real change frame — a record body is
 * bounded by the server's own content limit — but finite, so a peer that
 * streams without ever closing a frame cannot exhaust client memory.
 */
const MAX_SSE_BUFFER_BYTES = 8 * 1024 * 1024;

/** Null for a block carrying only comments — a keepalive is not a frame. */
function decodeFrame(block: string): SseFrame | null {
  let id: string | undefined;
  let event: string | undefined;
  const data: string[] = [];

  for (const line of block.split('\n')) {
    // A line opening with a colon is a comment. Keepalives arrive as one,
    // and exist so an idle connection is distinguishable from a dead one.
    if (line === '' || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'id') id = value;
    else if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
  }

  if (id === undefined && event === undefined && data.length === 0) return null;
  return { ...(id !== undefined && { id }), event: event ?? 'message', data: data.join('\n') };
}

/** Reconnect delay: exponential to a ceiling, then jittered across the whole range. */
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

/**
 * Full jitter rather than a fixed backoff: a server restart drops every
 * client at once, and an undithered schedule brings them all back
 * together — repeatedly, since the stampede that fails reconnects in
 * lockstep too.
 */
const reconnectDelay = (attempt: number): number => {
  const ceiling = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** attempt);
  return Math.random() * ceiling;
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Whether a feed error is one reconnecting cannot recover. A 4xx faults the
 * request, and the reconnect sends the same one, so retrying only spins. A
 * 5xx is the server's own trouble and may clear — a shed-load `timeout`
 * reconnects. The stream is closed by returning from the pump; the
 * subscriber has already been told via onError.
 */
const isFatalFeedError = (err: unknown): boolean => {
  if (err instanceof APIAdapterAuthError) return true;
  if (err instanceof StackError) {
    const status = WIRE_ERROR_STATUS[err.code];
    return status >= 400 && status < 500;
  }
  return false;
};

// -------------------------------------------------------
// Challenge–response handshake
// -------------------------------------------------------

/** Build the typed error for a rejected handshake response. */
const handshakeError = async (res: Response, path: string): Promise<Error> => {
  const body = await readJsonBody(res);
  if (isWireAuthError(body)) {
    return new APIAdapterHandshakeError(body.error.code, body.error.message);
  }
  return new APIAdapterHandshakeError(undefined, `HTTP ${res.status}: POST ${path}`);
};

/**
 * Earn a bearer token by proving possession of the credential's key.
 *
 * The signed payload binds the server's origin, so a signature made here
 * cannot be redeemed anywhere else — without that, a server a client
 * connects to could pass along a challenge from the client's real stack
 * and redeem the answer (docs/spec/wire-format.md § Authentication).
 *
 * A stale nonce is retried once: the window between issuing and signing is
 * small but real, and losing that race is not a credential failure.
 */
const performHandshake = async (
  baseUrl: string,
  credential: DidCredential,
  allowRetry = true,
): Promise<AuthTokenResponse> => {
  const post = (path: string, body: unknown): Promise<Response> =>
    fetchOrThrow(baseUrl, `${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  const challengeRes = await post('/auth/challenge', { did: credential.did });
  if (!challengeRes.ok) throw await handshakeError(challengeRes, '/auth/challenge');
  const challenge = (await challengeRes.json()) as AuthChallengeResponse;

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
  return (await tokenRes.json()) as AuthTokenResponse;
};

// -------------------------------------------------------
// APIAdapter
// -------------------------------------------------------

export class APIAdapter implements StackAdapter {
  readonly capabilities: AdapterCapabilities;
  readonly ownerEntityId: string;
  readonly timezone: string | undefined;

  /** Shared by every request that finds its token expired at the same moment. */
  private reauthInFlight: Promise<string> | null = null;

  private constructor(
    private readonly baseUrl: string,
    private token: string | undefined,
    private readonly credential: DidCredential | undefined,
    ownerEntityId: string,
    timezone: string | undefined,
    capabilities: AdapterCapabilities,
    /** The feed discovery advertised, if any. Absent means the server offers none. */
    private readonly changeFeed: DiscoveryChanges | undefined,
  ) {
    this.capabilities = capabilities;
    this.ownerEntityId = ownerEntityId;
    this.timezone = timezone;
  }

  /**
   * Connect to a remote stack server. Calls GET /.well-known/stack to verify
   * the server and populate AdapterCapabilities before returning.
   *
   * Throws APIAdapterAuthError on 401.
   * Throws APIAdapterConnectionError if the server is unreachable.
   * Throws APIAdapterOwnerMismatchError when `expectedOwner` disagrees with
   * the owner discovery reports.
   */
  static async open(opts: APIAdapterOpenOptions): Promise<APIAdapter> {
    const baseUrl = opts.url.replace(/\/$/, '');
    // Before the credential is spent and before anything is sent, for the
    // same reason the owner check comes early: a signature made over a
    // plaintext connection is already compromised by the time it fails.
    if (baseUrl.startsWith('http://') && !opts.allowInsecure && !isLoopbackUrl(baseUrl)) {
      throw new APIAdapterInsecureUrlError(baseUrl);
    }
    // Refused rather than resolved by precedence: one of the two would be
    // silently ignored, and which one is not obvious from either name.
    if (opts.token !== undefined && opts.credential !== undefined) {
      throw new APIAdapterError(
        'Pass either `token` or `credential`, not both: a static token and a DID credential ' +
          'are two ways to obtain the same session.',
      );
    }
    const res = await fetchOrThrow(baseUrl, `${baseUrl}/.well-known/stack`, {
      headers: authHeaders(opts.token),
    });

    if (res.status === 401) throw new APIAdapterAuthError();
    if (!res.ok) {
      throw new APIAdapterError(`Discovery failed: server returned ${res.status}`, res.status);
    }

    const discovery = (await res.json()) as DiscoveryResponse;

    if (!isProtocolCompatible(discovery.version ?? '')) {
      throw new APIAdapterVersionError(
        discovery.version,
        discovery.version
          ? `Server at "${baseUrl}" speaks wire protocol "${discovery.version}"; this client ` +
              `speaks "${WIRE_PROTOCOL_VERSION}".`
          : `Server at "${baseUrl}" reported no wire protocol version in discovery; ` +
              `"${WIRE_PROTOCOL_VERSION}" is required.`,
      );
    }

    // After version negotiation: a differing major means fields may not mean
    // what this client reads them as, so `entityId` isn't worth comparing yet.
    if (opts.expectedOwner !== undefined && discovery.entityId !== opts.expectedOwner) {
      throw new APIAdapterOwnerMismatchError(
        opts.expectedOwner,
        discovery.entityId,
        discovery.entityId
          ? `Server at "${baseUrl}" reports owner "${discovery.entityId}"; expected ` +
              `"${opts.expectedOwner}".`
          : `Server at "${baseUrl}" reported no owner in discovery; expected ` +
              `"${opts.expectedOwner}".`,
      );
    }

    // Last, so a credential is never spent on a server this client has
    // already decided to refuse — a signature is the one thing here that
    // keeps its value after the connection is abandoned.
    let token = opts.token;
    if (opts.credential) {
      if (!supportsDidChallenge(discovery)) {
        throw new APIAdapterAuthUnsupportedError(
          `Server at "${baseUrl}" does not advertise the "did-challenge" auth method; a DID ` +
            'credential has no handshake to perform against it.',
        );
      }
      token = (await performHandshake(baseUrl, opts.credential)).token;
    }

    return new APIAdapter(
      baseUrl,
      token,
      opts.credential,
      discovery.entityId,
      // Passthrough metadata only — no 'UTC' default, which would claim
      // knowledge the discovery response didn't actually provide.
      discovery.timezone,
      // One rule for every entry, applied once: absent, malformed or
      // unrecognized reads as the least capable value it could stand for.
      normalizeCapabilities(discovery.capabilities),
      // Kept whole rather than reduced to a flag: `resume` and `records`
      // are what subscribeChanges() promises its caller, and a client that
      // forgot them would assume both.
      supportsChangeFeed(discovery) ? discovery.changes : undefined,
    );
  }

  // -------------------------------------------------------
  // Request helpers
  // -------------------------------------------------------

  /**
   * Build the typed error for a failed response: `code` in the wire error
   * body is authoritative, falling back to status-based reconstruction,
   * then to a generic APIAdapterError. See docs/spec/wire-format.md
   * § Error responses.
   */
  private async errorForResponse(res: Response, method: string, path: string): Promise<Error> {
    const body = await readJsonBody(res);
    if (isWireError(body)) return deserializeError(body);
    const message = `HTTP ${res.status}: ${method} ${path}`;
    return errorForStatus(res.status, message) ?? new APIAdapterError(message, res.status);
  }

  /**
   * Renew the session, coalescing callers that found the same token stale.
   * A request whose token has already been replaced takes the new one
   * rather than spending a second handshake to arrive at it.
   */
  private async reauthenticate(staleToken: string | undefined): Promise<string> {
    if (this.token !== undefined && this.token !== staleToken) return this.token;
    this.reauthInFlight ??= performHandshake(this.baseUrl, this.credential!)
      .then((session) => {
        this.token = session.token;
        return session.token;
      })
      .finally(() => {
        this.reauthInFlight = null;
      });
    return this.reauthInFlight;
  }

  /**
   * Send a request, and on 401 renew the session once and repeat it. The
   * headers are rebuilt per attempt so the retry carries the new token.
   * Without a credential there is nothing to renew and the 401 stands.
   */
  private async send(url: string, build: (token: string | undefined) => RequestInit) {
    const attempt = (token: string | undefined): Promise<Response> =>
      fetchOrThrow(this.baseUrl, url, build(token));

    const stale = this.token;
    let res = await attempt(stale);
    if (res.status !== 401) return res;
    if (!this.credential) throw new APIAdapterAuthError();

    let renewed: string;
    try {
      renewed = await this.reauthenticate(stale);
    } catch (err) {
      throw new APIAdapterReauthError(
        `Session at "${this.baseUrl}" expired and re-authenticating failed.`,
        err,
      );
    }

    res = await attempt(renewed);
    // One retry, never a loop: a token minted seconds ago and refused is a
    // credential that no longer authorizes this request, not a stale session.
    if (res.status === 401) {
      throw new APIAdapterReauthError(
        `Re-authenticated against "${this.baseUrl}" and the retried request was still refused.`,
      );
    }
    return res;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    { nullOn404 = false, ifMatch }: { nullOn404?: boolean; ifMatch?: number } = {},
  ): Promise<T> {
    const res = await this.send(`${this.baseUrl}${path}`, (token) => {
      const headers = authHeaders(token);
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      // Opt-in optimistic-concurrency precondition (see Stack's ifVersion).
      // A mismatch gets a 412 with a version_conflict wire body, which
      // errorForResponse() below reconstructs as StackVersionConflictError.
      if (ifMatch !== undefined) headers['If-Match'] = `"${ifMatch}"`;
      return { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined };
    });

    if (res.status === 404 && nullOn404) return null as T;
    if (!res.ok) throw await this.errorForResponse(res, method, path);
    if (res.status === 204) return undefined as T;

    return (await parseJsonBody(res, method, path)) as T;
  }

  private async requestBinary(path: string): Promise<Uint8Array> {
    const res = await this.send(`${this.baseUrl}${path}`, (token) => ({
      headers: authHeaders(token),
    }));

    if (!res.ok) throw await this.errorForResponse(res, 'GET', path);
    return new Uint8Array(await res.arrayBuffer());
  }

  /** POST /attachments always returns the created _attachment@1 record — see putAttachmentWithMetadata() below. */
  private async uploadBinary(
    path: string,
    data: Uint8Array,
    mimeType: string,
    filename?: string,
    appId?: string,
  ): Promise<WireRecord | undefined> {
    const url = `${this.baseUrl}${path}${appId ? `?appId=${encodeURIComponent(appId)}` : ''}`;
    const res = await this.send(url, (token) => {
      const headers = authHeaders(token, { 'Content-Type': mimeType });
      if (filename)
        headers['Content-Disposition'] =
          `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`;
      return { method: 'POST', headers, body: data as unknown as BodyInit };
    });

    if (!res.ok) throw await this.errorForResponse(res, 'POST', path);
    return (await parseJsonBody(res, 'POST', path)) as WireRecord | undefined;
  }

  // -------------------------------------------------------
  // Records
  // -------------------------------------------------------

  async createRecord(record: StackRecord): Promise<StackRecord> {
    const raw = await this.request<WireRecord | undefined>('POST', '/records', record);
    return requireRecordBody(raw, 'POST /records');
  }

  async getRecord(id: RecordId): Promise<StackRecord | null> {
    const raw = await this.request<WireRecord | null | undefined>(
      'GET',
      `/records/${id}`,
      undefined,
      { nullOn404: true },
    );
    const body = requireNullableBody(raw, `GET /records/${id}`);
    return body ? parseRecord(body) : null;
  }

  async mutateRecord(
    id: RecordId,
    changes: RecordChangeSet,
    opts: { expectedVersion?: number } = {},
  ): Promise<StackRecord> {
    // The change set travels as-is — no record fields (typeId, version,
    // updatedAt) ride along. The server applies it against its own current
    // state and assigns the new version/updatedAt; the response is
    // authoritative. One If-Match fences the whole set.
    const raw = await this.request<WireRecord | undefined>('PATCH', `/records/${id}`, changes, {
      ifMatch: opts.expectedVersion,
    });
    return requireRecordBody(raw, `PATCH /records/${id}`);
  }

  async commitMigration(
    id: RecordId,
    toTypeId: TypeId,
    content: Record<string, unknown>,
    opts: { expectedVersion?: number } = {},
  ): Promise<StackRecord> {
    const raw = await this.request<WireRecord | undefined>(
      'POST',
      `/records/${id}/migrate`,
      { toTypeId, content },
      { ifMatch: opts.expectedVersion },
    );
    return requireRecordBody(raw, `POST /records/${id}/migrate`);
  }

  /**
   * A soft delete answers with the record it produced; a hard delete bumps
   * no version and answers with the record it destroyed, which is where
   * the files the purge stranded are read from. Null is reserved for a
   * purge that found nothing, the same shape a local adapter reports.
   */
  async deleteRecord(
    id: RecordId,
    opts: { hard?: boolean; expectedVersion?: number } = {},
  ): Promise<StackRecord | null> {
    const path = opts.hard ? `/records/${id}?hard=true` : `/records/${id}`;
    const raw = await this.request<WireRecord | null | undefined>('DELETE', path, undefined, {
      ifMatch: opts.expectedVersion,
      // An unconditional hard delete of a record that isn't there purged
      // nothing, which is not an error — the same answer the local
      // adapters give by returning null. A CAS is a real precondition, so
      // its 404 is left to throw.
      ...(opts.hard && opts.expectedVersion === undefined && { nullOn404: true }),
    });
    // The purge answers with the record it destroyed: it is the only
    // report of what it referenced, and every other row naming those files
    // is gone. See docs/spec/wire-format.md § Records.
    if (opts.hard) return raw === null ? null : requireRecordBody(raw, `DELETE ${path}`);
    return requireRecordBody(raw ?? undefined, `DELETE /records/${id}`);
  }

  async undeleteRecord(
    id: RecordId,
    opts: { expectedVersion?: number } = {},
  ): Promise<StackRecord> {
    const raw = await this.request<WireRecord | undefined>(
      'POST',
      `/records/${id}/undelete`,
      undefined,
      { ifMatch: opts.expectedVersion },
    );
    return requireRecordBody(raw, `POST /records/${id}/undelete`);
  }

  async queryRecords(query: StackQuery): Promise<QueryResult> {
    // Delegates the fail-loud decision to core's shared
    // assertQueryCapabilities so the wire and local paths enforce one rule
    // — re-thrown as APIAdapterCapabilityError for this adapter's callers.
    try {
      assertQueryCapabilities(query.filter, this.capabilities);
      assertSortCapability(query.sort, this.capabilities);
    } catch (err) {
      // The refusal names the capability it was refused for. A
      // StackBadRequestError carrying none is about the query's own shape — a
      // malformed content path, which is the caller's error at any
      // capability level — and travels as the StackBadRequestError it is.
      if (err instanceof StackBadRequestError && err.capability) {
        throw new APIAdapterCapabilityError(err.capability, err.message);
      }
      throw err;
    }
    // A malformed relationship filter is a caller error, not a missing
    // capability, so this one travels as the StackBadRequestError it is —
    // refused here rather than encoded into query params a server would
    // have to reject.
    assertValidRelatedTo(query.filter?.relatedTo);
    // Likewise for the two fields with no wire encoding, and before the
    // branch below rather than inside it: the query body carries them to a
    // server that answers 400, while the search params have nowhere to put
    // them, so encoding them here would let the server's content reach
    // decide whether a family query is refused or silently widened.
    assertQueryTravels(query);

    let raw: WireQueryResponse | undefined;
    let endpoint: string;
    if (filtersContent(this.capabilities)) {
      // POST /records/query supports the full query shape including content field filters
      endpoint = 'POST /records/query';
      raw = await this.request<WireQueryResponse | undefined>('POST', '/records/query', query);
    } else {
      // A server reaching no content only exposes GET /records
      const params = buildQueryParams(query);
      const qs = params.toString();
      endpoint = 'GET /records';
      raw = await this.request<WireQueryResponse | undefined>(
        'GET',
        qs ? `/records?${qs}` : '/records',
      );
    }

    const body = requireBody(raw, endpoint);
    return {
      records: body.records.map(parseRecord),
      cursor: body.cursor,
    };
  }

  // -------------------------------------------------------
  // Associations
  // -------------------------------------------------------

  /**
   * One storage primitive, two endpoints: authority and data share a
   * table and a delta, and never share a call, so the element's own kind
   * picks the surface it travels on. A permission routed through the
   * association endpoint would be refused by any server built on
   * `ScopedStack`, which is the partition doing its job.
   * See docs/spec/access-control.md § Storage unifies; the API does not.
   */
  private static associationPath(association: Association): string {
    return association.kind === 'permission' || association.kind === 'anyone'
      ? 'permissions'
      : 'associations';
  }

  /**
   * No `If-Match` — associate()/dissociate() never bump `version`, so
   * there's nothing an `ifVersion` precondition could guard here. See
   * docs/spec/versioning.md § Version history.
   */
  async associate(id: RecordId, association: Association): Promise<StackRecord> {
    const path = `/records/${id}/${APIAdapter.associationPath(association)}`;
    const raw = await this.request<WireRecord | undefined>('POST', path, association);
    return requireRecordBody(raw, `POST ${path}`);
  }

  /** No `If-Match` — see associate(). */
  async dissociate(id: RecordId, association: Association): Promise<StackRecord> {
    // POST, not DELETE — a DELETE body has no defined semantics (RFC 9110
    // §9.3.5) and proxies/gateways are free to drop or reject it.
    const path = `/records/${id}/${APIAdapter.associationPath(association)}/delete`;
    const raw = await this.request<WireRecord | undefined>('POST', path, association);
    return requireRecordBody(raw, `POST ${path}`);
  }

  // -------------------------------------------------------
  // Versions
  // -------------------------------------------------------

  async getVersions(id: RecordId): Promise<RecordVersion[]> {
    const raw = await this.request<WireVersion[] | undefined>('GET', `/records/${id}/versions`);
    return requireBody(raw, `GET /records/${id}/versions`).map(parseVersion);
  }

  /**
   * Reads the window the caller asked for, across as many requests as the
   * server's own page cap takes. A server may answer a page shorter than
   * the `limit` asked for — the endpoint is the one read with no ceiling
   * when `limit` is omitted, so it needs that freedom — and a caller
   * reconstructing an association's full history would silently get a
   * prefix if this returned the first page. `cursor` is the only
   * end-of-log signal, exactly as it is on a query.
   *
   * See docs/spec/wire-format.md § Journal.
   */
  async getJournal(id: RecordId, query: JournalQuery = {}): Promise<RecordJournalEntry[]> {
    const entries: RecordJournalEntry[] = [];
    let sinceSeq = query.sinceSeq;
    for (;;) {
      // Asks only for what is still outstanding, so a server honoring the
      // limit exactly answers a bounded read in one request.
      const remaining = query.limit === undefined ? undefined : query.limit - entries.length;
      if (remaining !== undefined && remaining <= 0) break;
      const params = new URLSearchParams();
      if (sinceSeq !== undefined) params.set('sinceSeq', String(sinceSeq));
      if (remaining !== undefined) params.set('limit', String(remaining));
      const qs = params.toString();
      const path = `/records/${id}/journal${qs ? `?${qs}` : ''}`;
      const raw = await this.request<WireJournalResponse | undefined>('GET', path);
      const body = requireBody(raw, `GET ${path}`);
      // Appended one at a time rather than spread: a spread is an argument
      // list, and this is the one read a server may answer without a ceiling.
      for (const e of body.entries) entries.push(parseJournalEntry(e));
      if (body.entries.length === 0) break;
      // Only a cursor past the window just asked for can land the next
      // request somewhere new. A server that omits one, repeats one, or
      // mints one unconditionally ends the read here rather than spinning
      // on it. See docs/spec/wire-format.md § Journal.
      if (typeof body.cursor !== 'number' || (sinceSeq !== undefined && body.cursor <= sinceSeq)) {
        break;
      }
      sinceSeq = body.cursor;
    }
    // `limit` is this method's own ceiling, not a request the server is
    // trusted to have honored: a page longer than the one asked for would
    // otherwise hand the caller more than the contract allows.
    return query.limit === undefined ? entries : entries.slice(0, query.limit);
  }

  async getVersion(id: RecordId, version: number): Promise<RecordVersion | null> {
    const raw = await this.request<WireVersion | null | undefined>(
      'GET',
      `/records/${id}/versions/${version}`,
      undefined,
      { nullOn404: true },
    );
    const body = requireNullableBody(raw, `GET /records/${id}/versions/${version}`);
    return body ? parseVersion(body) : null;
  }

  async saveVersion(_id: RecordId, _version: RecordVersion): Promise<void> {
    // The server snapshots versions automatically as a side effect of every
    // mutating endpoint. There is no client-initiated saveVersion endpoint
    // in the wire protocol.
  }

  /**
   * Never restores `associations` — no snapshot carries them, so there is
   * nothing the server could restore associations *from*. See
   * docs/spec/versioning.md § Restore semantics.
   */
  async restoreVersion(
    id: RecordId,
    version: number,
    opts: { expectedVersion?: number } = {},
  ): Promise<StackRecord> {
    const raw = await this.request<WireRecord | undefined>(
      'POST',
      `/records/${id}/restore/${version}`,
      undefined,
      { ifMatch: opts.expectedVersion },
    );
    return requireRecordBody(raw, `POST /records/${id}/restore/${version}`);
  }

  // -------------------------------------------------------
  // Types
  // -------------------------------------------------------

  async saveType(type: StackType): Promise<void> {
    await this.request<void>('POST', '/types', type);
  }

  async getType(id: TypeId): Promise<StackType | null> {
    const raw = await this.request<WireType | null | undefined>(
      'GET',
      `/types/${encodeURIComponent(id)}`,
      undefined,
      { nullOn404: true },
    );
    const body = requireNullableBody(raw, `GET /types/${id}`);
    return body ? parseType(body) : null;
  }

  async listTypes(): Promise<StackType[]> {
    const raw = await this.request<WireType[] | undefined>('GET', '/types');
    return requireBody(raw, 'GET /types').map(parseType);
  }

  // -------------------------------------------------------
  // Attachments
  // -------------------------------------------------------

  /**
   * Unsupported over the wire — always throws. There is no bytes-only
   * upload endpoint to map to, and implementing one anyway would silently
   * mint a record with a default mimeType. Stack.putAttachment() never
   * reaches this on this adapter; the throw guards direct adapter-level
   * callers. See docs/spec/wire-format.md § Upload.
   */
  async putAttachment(_data: Uint8Array): Promise<FileId> {
    throw new APIAdapterError(
      'Bytes-only upload is not supported over the wire: POST /attachments always creates ' +
        'an _attachment@1 record. Use Stack.putAttachment(data, { mimeType, filename? }).',
    );
  }

  /**
   * StackAdapter's optional atomic-upload capability: bytes + _attachment@1
   * record in one POST /attachments request. The one adapter that can
   * offer it — bytes and records live behind the same boundary (the
   * server). A security boundary, not an efficiency shortcut; see
   * docs/spec/wire-format.md § Upload.
   */
  async putAttachmentWithMetadata(
    data: Uint8Array,
    opts: PutAttachmentOptions,
  ): Promise<StackRecord> {
    const { mimeType, filename, appId } = opts;
    const raw = await this.uploadBinary('/attachments', data, mimeType, filename, appId);
    return requireRecordBody(raw, 'POST /attachments');
  }

  async getAttachment(fileId: FileId): Promise<Uint8Array> {
    return this.requestBinary(`/attachments/${fileId}`);
  }

  async deleteAttachment(fileId: FileId): Promise<void> {
    await this.request<void>('DELETE', `/attachments/${fileId}`);
  }

  // -------------------------------------------------------
  // Change feed
  // -------------------------------------------------------

  /**
   * Relay the server's change feed. Resolves once the stream is live —
   * after the server's `ready` frame — so that subscribe-then-query is
   * gap-free: every change from that point on arrives as a frame.
   *
   * Reconnection is this adapter's business and the subscriber never hears
   * about it, so long as the cursor closes the gap. `onReset` is what a gap
   * it could not close looks like, and reconciling by query is the repair.
   * See docs/spec/change-feed.md.
   */
  async subscribeChanges(
    opts: SubscribeChangesOptions,
    handler: (change: RecordChange) => void,
  ): Promise<() => void> {
    // Refused locally, before any request: a server advertising no feed has
    // no endpoint to answer, and learning that as a 404 partway through a
    // connection is the failure discovery exists to prevent.
    if (!this.changeFeed) {
      throw new APIAdapterCapabilityError(
        'changes',
        `Server at "${this.baseUrl}" advertises no change feed. Poll query() for changes, or ` +
          'connect to a server that offers one.',
      );
    }

    // A resume cursor becomes a Last-Event-ID header, so it must stay
    // inside the framable charset for the same reason a frame's own id
    // does: an out-of-charset value would span the header line. Refused
    // locally rather than handed to fetch, which rejects it opaquely.
    if (opts.since !== undefined && !isValidSeq(opts.since)) {
      throw new APIAdapterError(
        `Resume cursor "${opts.since}" is not a valid seq (unreserved base64url characters only).`,
      );
    }

    const controller = new AbortController();
    const params = buildChangeParams(opts);
    const query = params.toString();
    const url = `${this.baseUrl}/changes${query ? `?${query}` : ''}`;

    let stopped = false;
    let settled = false;
    let cursor = opts.since;

    let onLive: () => void;
    let onFailed: (err: unknown) => void;
    const live = new Promise<void>((resolve, reject) => {
      onLive = resolve;
      onFailed = reject;
    });

    const dispatch = (frame: SseFrame, headSeq: () => string | undefined): void => {
      // A frame id is a stream position whatever the frame says, so an
      // unrecognized name still advances the cursor. One outside the
      // framable charset is discarded rather than echoed into a header.
      if (frame.id !== undefined && isValidSeq(frame.id)) cursor = frame.id;

      switch (frame.event) {
        case CHANGE_FRAME_READY:
          if (!settled) {
            settled = true;
            onLive();
          }
          return;
        case CHANGE_FRAME_RECORD: {
          // A single unparseable record frame is a server defect, not a
          // dead connection: report it and read on, rather than tearing the
          // stream down and reconnecting into the same frame.
          let change: RecordChange;
          try {
            change = parseChange(JSON.parse(frame.data) as WireRecordChange);
          } catch (err) {
            opts.onError?.(err);
            return;
          }
          handler(change);
          return;
        }
        case CHANGE_FRAME_RESET:
          // The cursor is worthless now, so the next reconnect starts from
          // this connection's head rather than replaying against a
          // position the server has already refused.
          cursor = headSeq();
          opts.onReset?.();
          return;
        default:
          // A name this client does not know is ignored, never an error:
          // that is what makes a later frame additive rather than a break.
          return;
      }
    };

    const pump = async (): Promise<void> => {
      let attempt = 0;
      while (!stopped) {
        const openedAt = Date.now();
        try {
          await this.readFeed(url, controller, () => cursor, dispatch);
        } catch (err) {
          if (stopped) return;
          // A first connection that never came up is the caller's error to
          // handle, not a reconnect: subscribeChanges() has not resolved.
          if (!settled) {
            settled = true;
            onFailed(err);
            return;
          }
          opts.onError?.(err);
          // A credential that cannot authenticate or is not authorized will
          // fail the reconnect the same way: reconnecting only spins. The
          // caller was told through onError; stop rather than loop until it
          // unsubscribes. A transient drop (network, 5xx, overflow-close)
          // is not fatal and reconnects below.
          if (isFatalFeedError(err)) return;
        }
        if (stopped) return;
        // A connection that stayed up did its job; only a flapping one
        // escalates. Without this, a server accepting and dropping in
        // sequence would be reconnected against as fast as it could refuse.
        if (Date.now() - openedAt >= RECONNECT_BASE_MS) attempt = 0;
        await sleep(reconnectDelay(attempt++));
      }
    };

    void pump();
    await live;

    return () => {
      stopped = true;
      controller.abort();
    };
  }

  /**
   * One connection, read to its end. Returns when the server closes the
   * stream — an ordinary event that the caller answers by reconnecting,
   * not a failure.
   */
  private async readFeed(
    url: string,
    controller: AbortController,
    cursor: () => string | undefined,
    dispatch: (frame: SseFrame, headSeq: () => string | undefined) => void,
  ): Promise<void> {
    const res = await this.send(url, (token) => {
      const headers = authHeaders(token, { Accept: 'text/event-stream' });
      const since = cursor();
      if (since !== undefined) headers['Last-Event-ID'] = since;
      return { headers, signal: controller.signal };
    });

    if (!res.ok) throw await this.errorForResponse(res, 'GET', '/changes');
    if (!res.body) {
      throw new APIAdapterError(`GET /changes at "${this.baseUrl}" answered with no stream body.`);
    }

    // This connection's own head, as its ready frame reported it — the
    // position a reset falls back to.
    let head: string | undefined;
    const headSeq = () => head;

    const decoder = new SseDecoder();
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        for (const frame of decoder.push(value)) {
          if (frame.event === CHANGE_FRAME_READY && head === undefined) {
            // A malformed ready payload costs the reset fallback its head
            // cursor, not the connection: treat the head as unknown. The
            // seq is charset-checked like a frame id, since it becomes the
            // Last-Event-ID fetch would refuse on every reconnect.
            try {
              const seq = (JSON.parse(frame.data || '{}') as { seq?: string }).seq;
              head = seq !== undefined && isValidSeq(seq) ? seq : undefined;
            } catch {
              head = undefined;
            }
          }
          dispatch(frame, headSeq);
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  // -------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------

  async flush(): Promise<void> {
    // Each request commits immediately; nothing to flush client-side.
  }

  async close(): Promise<void> {
    // Stateless HTTP client; nothing to tear down.
  }
}
