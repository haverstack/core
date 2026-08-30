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
 * optimistic concurrency (ifVersion → If-Match) is supported: see
 * patchContent()/deleteRecord()/etc.'s expectedVersion option.
 */

import { StackError, StackQueryError } from '@haverstack/core';
import type {
  StackAdapter,
  StackRecord,
  StackType,
  TypeSchema,
  TypeId,
  RecordVersion,
  StackQuery,
  QueryResult,
  Association,
  Permission,
  RecordId,
  FileId,
  EntityId,
  ChangeFilter,
  RecordChange,
} from '@haverstack/core';
import { assertQueryCapabilities, assertValidRelatedTo } from '@haverstack/core/adapter';
import type { AdapterCapabilities, SubscribeChangesOptions } from '@haverstack/core/adapter';
import { buildAuthChallengePayload, base64urlEncode } from '@haverstack/core/wire';
import type { DidCredential } from '@haverstack/core/wire';
import type {
  WireRecord,
  WireQueryResponse,
  WireType,
  WireVersion,
  WireRecordChange,
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
} from '@haverstack/wire-types';

// -------------------------------------------------------
// Public option types
// -------------------------------------------------------

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
    /** `'changes'` names the feed, which discovery advertises beside `capabilities` rather than in it. */
    public readonly capability: keyof AdapterCapabilities | 'changes',
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
// Domain object parsers (wire JSON → typed domain objects)
// -------------------------------------------------------
//
// Responses only. This adapter is a client: it never reads a request body,
// so the identity fields a server assigns from the session — entityId,
// principalId, updatedBy, updatedVia — arrive already decided, and parsing
// them is reading an answer rather than accepting a claim.
// See docs/spec/wire-format.md § Records.

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
  if (raw.entityId != null) record.entityId = raw.entityId;
  if (raw.appId != null) record.appId = raw.appId;
  if (raw.principalId != null) record.principalId = raw.principalId;
  if (raw.updatedBy != null) record.updatedBy = raw.updatedBy;
  if (raw.updatedVia != null) record.updatedVia = raw.updatedVia;
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
  if (raw.entityId != null) v.entityId = raw.entityId;
  if (raw.updatedBy != null) v.updatedBy = raw.updatedBy;
  if (raw.updatedVia != null) v.updatedVia = raw.updatedVia;
  if (raw.associations != null) v.associations = raw.associations;
  if (raw.permissions != null) v.permissions = raw.permissions;
  return v;
};

// -------------------------------------------------------
// Query parameter builder (used when contentFieldQuery is false)
// -------------------------------------------------------

const buildQueryParams = (query: StackQuery): URLSearchParams => {
  const p = new URLSearchParams();
  const f = query.filter ?? {};

  if (f.typeId !== undefined) {
    const ids = Array.isArray(f.typeId) ? f.typeId : [f.typeId];
    for (const id of ids) p.append('typeId', id);
  }
  if (f.parentId !== undefined) p.set('parentId', f.parentId === null ? 'null' : f.parentId);
  if (f.appId !== undefined) {
    const ids = Array.isArray(f.appId) ? f.appId : [f.appId];
    for (const id of ids) p.append('appId', id);
  }
  if (f.entityId !== undefined) {
    const ids = Array.isArray(f.entityId) ? f.entityId : [f.entityId];
    for (const id of ids) p.append('entityId', id);
  }
  if (f.principalId !== undefined) {
    const ids = Array.isArray(f.principalId) ? f.principalId : [f.principalId];
    for (const id of ids) p.append('principalId', id);
  }
  if (f.createdAt?.before) p.set('createdBefore', f.createdAt.before.toISOString());
  if (f.createdAt?.after) p.set('createdAfter', f.createdAt.after.toISOString());
  if (f.updatedAt?.before) p.set('updatedBefore', f.updatedAt.before.toISOString());
  if (f.updatedAt?.after) p.set('updatedAfter', f.updatedAt.after.toISOString());
  if (f.tags) for (const tag of f.tags) p.append('tag', tag);
  if (f.hasAttachment) p.set('hasAttachment', f.hasAttachment);
  if (f.attachmentFileId) p.set('attachmentFileId', f.attachmentFileId);
  if (f.relatedTo) {
    // The scope is implied by which qualifier appears, and the type
    // guarantees at least one of these branches sets something — so the
    // filter can never encode to nothing and silently widen the query.
    // The server rejects a mix of scopes.
    const t = f.relatedTo.target;
    if (t?.scope === 'record') {
      p.set('relatedTo', t.recordId);
      if (t.stackUrl !== undefined) p.set('relatedToStack', t.stackUrl);
    } else if (t?.scope === 'entity') {
      p.set('relatedToEntity', t.entityId);
    } else if (t?.scope === 'external') {
      p.set('relatedToNs', t.ns);
      if (t.id !== undefined) p.set('relatedToId', t.id);
    }
    if (f.relatedTo.label !== undefined) p.set('relatedToLabel', f.relatedTo.label);
  }
  if (f.search) p.set('search', f.search);
  if (f.includeDeleted) p.set('includeDeleted', 'true');
  if (f.includeUnlisted) p.set('includeUnlisted', 'true');
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
    op: raw.op,
    recordId: raw.recordId,
    typeId: raw.typeId,
    version: raw.version,
    updatedAt: new Date(raw.updatedAt),
  };
  if (raw.actor != null) {
    change.actor = {
      entityId: raw.actor.entityId,
      ...(raw.actor.principalId != null && { principalId: raw.actor.principalId }),
      ...(raw.actor.appId != null && { appId: raw.actor.appId }),
    };
  }
  if (raw.seq != null) change.seq = raw.seq;
  // A purge carries nothing about the record it destroyed. A conformant
  // server sends neither field on one; dropping them here means a server
  // that does cannot hand a subscriber the copy the verb exists to erase.
  if (raw.kind === 'purged') return change;
  if (raw.parentId != null) change.parentId = raw.parentId;
  if (raw.record != null) change.record = parseRecord(raw.record);
  return change;
};

const buildChangeParams = (opts: SubscribeChangesOptions): URLSearchParams => {
  const p = new URLSearchParams();
  const f: ChangeFilter = opts.filter ?? {};

  if (f.typeId !== undefined) {
    const ids = Array.isArray(f.typeId) ? f.typeId : [f.typeId];
    for (const id of ids) p.append('typeId', id);
  }
  if (f.parentId !== undefined) p.set('parentId', f.parentId === null ? 'null' : f.parentId);
  if (f.entityId !== undefined) p.set('entityId', f.entityId);
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
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = undefined;
  }
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
  const fetchOrThrow = async (path: string, body: unknown): Promise<Response> => {
    try {
      return await fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new APIAdapterConnectionError(baseUrl, err);
    }
  };

  const challengeRes = await fetchOrThrow('/auth/challenge', { did: credential.did });
  if (!challengeRes.ok) throw await handshakeError(challengeRes, '/auth/challenge');
  const challenge = (await challengeRes.json()) as AuthChallengeResponse;

  const signature = await credential.sign(
    buildAuthChallengePayload({ origin: baseUrl, did: credential.did, nonce: challenge.nonce }),
  );

  const tokenRes = await fetchOrThrow('/auth/token', {
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
    // Refused rather than resolved by precedence: one of the two would be
    // silently ignored, and which one is not obvious from either name.
    if (opts.token !== undefined && opts.credential !== undefined) {
      throw new APIAdapterError(
        'Pass either `token` or `credential`, not both: a static token and a DID credential ' +
          'are two ways to obtain the same session.',
      );
    }
    const headers: Record<string, string> = opts.token
      ? { Authorization: `Bearer ${opts.token}` }
      : {};

    let res: Response;
    try {
      res = await fetch(`${baseUrl}/.well-known/stack`, { headers });
    } catch (err) {
      throw new APIAdapterConnectionError(baseUrl, err);
    }

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
      {
        ...discovery.capabilities,
        // A server predating this field, or one declining to publish its
        // limit, means "you can't pre-check" — not "unbounded" and not
        // undefined leaking into a numeric comparison. Its own
        // request-size limit is authoritative either way.
        maxContentBytes: discovery.capabilities?.maxContentBytes ?? null,
      },
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
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      body = undefined;
    }
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
    const attempt = async (token: string | undefined): Promise<Response> => {
      try {
        return await fetch(url, build(token));
      } catch (err) {
        throw new APIAdapterConnectionError(this.baseUrl, err);
      }
    };

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
      const headers: Record<string, string> = {};
      if (token) headers['Authorization'] = `Bearer ${token}`;
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
    return res.json() as Promise<T>;
  }

  private async requestBinary(path: string): Promise<Uint8Array> {
    const res = await this.send(`${this.baseUrl}${path}`, (token) => {
      const headers: Record<string, string> = {};
      if (token) headers['Authorization'] = `Bearer ${token}`;
      return { headers };
    });

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
  ): Promise<WireRecord> {
    const url = `${this.baseUrl}${path}${appId ? `?appId=${encodeURIComponent(appId)}` : ''}`;
    const res = await this.send(url, (token) => {
      const headers: Record<string, string> = { 'Content-Type': mimeType };
      if (token) headers['Authorization'] = `Bearer ${token}`;
      if (filename)
        headers['Content-Disposition'] =
          `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`;
      return { method: 'POST', headers, body: data as unknown as BodyInit };
    });

    if (!res.ok) throw await this.errorForResponse(res, 'POST', path);
    return res.json() as Promise<WireRecord>;
  }

  // -------------------------------------------------------
  // Records
  // -------------------------------------------------------

  async createRecord(record: StackRecord): Promise<StackRecord> {
    const raw = await this.request<WireRecord>('POST', '/records', record);
    return parseRecord(raw);
  }

  async getRecord(id: RecordId): Promise<StackRecord | null> {
    const raw = await this.request<WireRecord | null>('GET', `/records/${id}`, undefined, {
      nullOn404: true,
    });
    return raw ? parseRecord(raw) : null;
  }

  async patchContent(
    id: RecordId,
    patch: Record<string, unknown | null>,
    opts: { expectedVersion?: number } = {},
  ): Promise<StackRecord> {
    // Content-only RFC 7396 merge patch — no record fields (typeId, version,
    // updatedAt) travel in this body. The server merges against its own
    // current state and assigns the new version/updatedAt; the response is
    // authoritative.
    const raw = await this.request<WireRecord>('PATCH', `/records/${id}`, patch, {
      ifMatch: opts.expectedVersion,
    });
    return parseRecord(raw);
  }

  async commitMigration(
    id: RecordId,
    toTypeId: TypeId,
    content: Record<string, unknown>,
    opts: { expectedVersion?: number } = {},
  ): Promise<StackRecord> {
    const raw = await this.request<WireRecord>(
      'POST',
      `/records/${id}/migrate`,
      { toTypeId, content },
      { ifMatch: opts.expectedVersion },
    );
    return parseRecord(raw);
  }

  /**
   * A soft delete answers with the record it produced; a hard delete bumps
   * no version, so it has none to answer with and returns 204 — null here,
   * the same shape a local adapter reports for a record that was not there.
   */
  async deleteRecord(
    id: RecordId,
    opts: { hard?: boolean; expectedVersion?: number } = {},
  ): Promise<StackRecord | null> {
    const path = opts.hard ? `/records/${id}?hard=true` : `/records/${id}`;
    const raw = await this.request<WireRecord | undefined>('DELETE', path, undefined, {
      ifMatch: opts.expectedVersion,
    });
    if (opts.hard) return raw ? parseRecord(raw) : null;
    return requireRecordBody(raw, `DELETE /records/${id}`);
  }

  async undeleteRecord(
    id: RecordId,
    opts: { expectedVersion?: number } = {},
  ): Promise<StackRecord> {
    const raw = await this.request<WireRecord>('POST', `/records/${id}/undelete`, undefined, {
      ifMatch: opts.expectedVersion,
    });
    return parseRecord(raw);
  }

  async queryRecords(query: StackQuery): Promise<QueryResult> {
    // Delegates the fail-loud decision to core's shared
    // assertQueryCapabilities so the wire and local paths enforce one rule
    // — re-thrown as APIAdapterCapabilityError for this adapter's callers.
    try {
      assertQueryCapabilities(query.filter, this.capabilities);
    } catch (err) {
      if (!(err instanceof StackQueryError)) throw err;
      const capability: keyof AdapterCapabilities =
        query.filter?.search && !this.capabilities.fullTextSearch
          ? 'fullTextSearch'
          : 'contentFieldQuery';
      throw new APIAdapterCapabilityError(capability, err.message);
    }
    // A malformed relationship filter is a caller error, not a missing
    // capability, so this one travels as the StackQueryError it is —
    // refused here rather than encoded into query params a server would
    // have to reject.
    assertValidRelatedTo(query.filter?.relatedTo);

    let raw: WireQueryResponse;
    if (this.capabilities.contentFieldQuery) {
      // POST /records/query supports the full query shape including content field filters
      raw = await this.request<WireQueryResponse>('POST', '/records/query', query);
    } else {
      // Servers without contentFieldQuery support only expose GET /records
      const params = buildQueryParams(query);
      const qs = params.toString();
      raw = await this.request<WireQueryResponse>('GET', qs ? `/records?${qs}` : '/records');
    }

    return {
      records: raw.records.map(parseRecord),
      cursor: raw.cursor,
      // Always null, whatever the server sent. Every wire response has
      // passed a permission boundary, so a count that ignores pagination
      // reports records the requester can't read — a server MUST NOT
      // populate this, and an app that reads `total` must behave the same
      // here as it does under ScopedStack, which also always reports null.
      // See docs/spec/wire-format.md § Response envelope.
      total: null,
    };
  }

  // -------------------------------------------------------
  // Associations
  // -------------------------------------------------------

  async associate(
    id: RecordId,
    association: Association,
    opts: { expectedVersion?: number } = {},
  ): Promise<StackRecord> {
    const raw = await this.request<WireRecord | undefined>(
      'POST',
      `/records/${id}/associations`,
      association,
      { ifMatch: opts.expectedVersion },
    );
    return requireRecordBody(raw, `POST /records/${id}/associations`);
  }

  async dissociate(
    id: RecordId,
    association: Association,
    opts: { expectedVersion?: number } = {},
  ): Promise<StackRecord> {
    // POST, not DELETE — a DELETE body has no defined semantics (RFC 9110
    // §9.3.5) and proxies/gateways are free to drop or reject it.
    const raw = await this.request<WireRecord | undefined>(
      'POST',
      `/records/${id}/associations/delete`,
      association,
      { ifMatch: opts.expectedVersion },
    );
    return requireRecordBody(raw, `POST /records/${id}/associations/delete`);
  }

  // -------------------------------------------------------
  // Permissions
  // -------------------------------------------------------

  async setPermissions(
    id: RecordId,
    permissions: Permission[],
    opts: { expectedVersion?: number } = {},
  ): Promise<StackRecord> {
    const raw = await this.request<WireRecord | undefined>(
      'PUT',
      `/records/${id}/permissions`,
      { permissions },
      {
        ifMatch: opts.expectedVersion,
      },
    );
    return requireRecordBody(raw, `PUT /records/${id}/permissions`);
  }

  async setUnlisted(
    id: RecordId,
    unlisted: boolean,
    opts: { expectedVersion?: number } = {},
  ): Promise<StackRecord> {
    const raw = await this.request<WireRecord | undefined>(
      'PUT',
      `/records/${id}/unlisted`,
      { unlisted },
      {
        ifMatch: opts.expectedVersion,
      },
    );
    return requireRecordBody(raw, `PUT /records/${id}/unlisted`);
  }

  // -------------------------------------------------------
  // Versions
  // -------------------------------------------------------

  async getVersions(id: RecordId): Promise<RecordVersion[]> {
    const raw = await this.request<WireVersion[]>('GET', `/records/${id}/versions`);
    return raw.map(parseVersion);
  }

  async getVersion(id: RecordId, version: number): Promise<RecordVersion | null> {
    const raw = await this.request<WireVersion | null>(
      'GET',
      `/records/${id}/versions/${version}`,
      undefined,
      { nullOn404: true },
    );
    return raw ? parseVersion(raw) : null;
  }

  async saveVersion(_id: RecordId, _version: RecordVersion): Promise<void> {
    // The server snapshots versions automatically as a side effect of every
    // mutating endpoint. There is no client-initiated saveVersion endpoint
    // in the wire protocol.
  }

  async restoreVersion(
    id: RecordId,
    version: number,
    opts: { expectedVersion?: number } = {},
  ): Promise<StackRecord> {
    const raw = await this.request<WireRecord>(
      'POST',
      `/records/${id}/restore/${version}`,
      undefined,
      { ifMatch: opts.expectedVersion },
    );
    return parseRecord(raw);
  }

  // -------------------------------------------------------
  // Types
  // -------------------------------------------------------

  async saveType(type: StackType): Promise<void> {
    await this.request<void>('POST', '/types', type);
  }

  async getType(id: TypeId): Promise<StackType | null> {
    const raw = await this.request<WireType | null>(
      'GET',
      `/types/${encodeURIComponent(id)}`,
      undefined,
      { nullOn404: true },
    );
    return raw ? parseType(raw) : null;
  }

  async listTypes(): Promise<StackType[]> {
    const raw = await this.request<WireType[]>('GET', '/types');
    return raw.map(parseType);
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
        'an _attachment@1 record. Use Stack.putAttachment(data, mimeType, filename?).',
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
    mimeType: string,
    filename?: string,
    appId?: string,
  ): Promise<StackRecord> {
    return parseRecord(await this.uploadBinary('/attachments', data, mimeType, filename, appId));
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
   * See docs/spec/wire-format.md § Change feed.
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
      const headers: Record<string, string> = { Accept: 'text/event-stream' };
      if (token) headers['Authorization'] = `Bearer ${token}`;
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
            // cursor, not the connection: treat the head as unknown.
            try {
              head = (JSON.parse(frame.data || '{}') as { seq?: string }).seq;
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
