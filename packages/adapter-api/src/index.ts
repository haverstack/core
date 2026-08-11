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

import {
  assertQueryCapabilities,
  StackQueryError,
  buildAuthChallengePayload,
  base64urlEncode,
} from '@haverstack/core';
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
  AdapterCapabilities,
  RecordId,
  FileId,
  EntityId,
  DidCredential,
} from '@haverstack/core';
import type {
  WireRecord,
  WireType,
  WireVersion,
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
  supportsDidChallenge,
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
    public readonly capability: keyof AdapterCapabilities,
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
  if (raw.deletedAt != null) record.deletedAt = new Date(raw.deletedAt);
  if (raw.permissions != null) record.permissions = raw.permissions;
  if (raw.associations != null) record.associations = raw.associations;
  return record;
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
    p.set('relatedTo', f.relatedTo.recordId);
    if (f.relatedTo.label) p.set('relatedToLabel', f.relatedTo.label);
  }
  if (f.search) p.set('search', f.search);
  if (f.includeDeleted) p.set('includeDeleted', 'true');
  if (query.sort?.field) p.set('sort', query.sort.field);
  if (query.sort?.direction) p.set('direction', query.sort.direction);
  if (query.limit) p.set('limit', String(query.limit));
  if (query.cursor) p.set('cursor', query.cursor);

  return p;
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
      discovery.capabilities,
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
  ): Promise<StackRecord> {
    const raw = await this.request<WireRecord>('POST', `/records/${id}/migrate`, {
      toTypeId,
      content,
    });
    return parseRecord(raw);
  }

  async deleteRecord(
    id: RecordId,
    opts: { hard?: boolean; expectedVersion?: number } = {},
  ): Promise<void> {
    const path = opts.hard ? `/records/${id}?hard=true` : `/records/${id}`;
    await this.request<void>('DELETE', path, undefined, { ifMatch: opts.expectedVersion });
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
    type Envelope = {
      records: WireRecord[];
      cursor: string | null;
      total: number | null;
    };

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

    let raw: Envelope;
    if (this.capabilities.contentFieldQuery) {
      // POST /records/query supports the full query shape including content field filters
      raw = await this.request<Envelope>('POST', '/records/query', query);
    } else {
      // Servers without contentFieldQuery support only expose GET /records
      const params = buildQueryParams(query);
      const qs = params.toString();
      raw = await this.request<Envelope>('GET', qs ? `/records?${qs}` : '/records');
    }

    return {
      records: raw.records.map(parseRecord),
      cursor: raw.cursor,
      total: raw.total,
    };
  }

  // -------------------------------------------------------
  // Associations
  // -------------------------------------------------------

  async associate(
    id: RecordId,
    association: Association,
    opts: { expectedVersion?: number } = {},
  ): Promise<void> {
    await this.request<void>('POST', `/records/${id}/associations`, association, {
      ifMatch: opts.expectedVersion,
    });
  }

  async dissociate(
    id: RecordId,
    association: Association,
    opts: { expectedVersion?: number } = {},
  ): Promise<void> {
    // POST, not DELETE — a DELETE body has no defined semantics (RFC 9110
    // §9.3.5) and proxies/gateways are free to drop or reject it.
    await this.request<void>('POST', `/records/${id}/associations/delete`, association, {
      ifMatch: opts.expectedVersion,
    });
  }

  // -------------------------------------------------------
  // Permissions
  // -------------------------------------------------------

  async setPermissions(
    id: RecordId,
    permissions: Permission[],
    opts: { expectedVersion?: number } = {},
  ): Promise<void> {
    await this.request<void>(
      'PUT',
      `/records/${id}/permissions`,
      { permissions },
      {
        ifMatch: opts.expectedVersion,
      },
    );
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
  // Lifecycle
  // -------------------------------------------------------

  async flush(): Promise<void> {
    // Each request commits immediately; nothing to flush client-side.
  }

  async close(): Promise<void> {
    // Stateless HTTP client; nothing to tear down.
  }
}
