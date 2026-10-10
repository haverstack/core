/**
 * Stack — API Adapter
 * -------------------------------------------------------
 * Implements StackAdapter over HTTP. On open(), calls the
 * discovery endpoint to populate StackCapabilities before
 * returning, so capabilities are available synchronously
 * once the adapter is in hand.
 *
 * Authentication uses a bearer token in the Authorization header. A token
 * is either handed in (`token`) or earned by proving key possession
 * against a DID (`credential`) — see docs/spec/wire-format.md
 * § Authentication.
 *
 * Every call is a request: nothing is queued while the server is
 * unreachable. Opt-in optimistic concurrency (ifVersion → If-Match) is
 * supported: see the ifVersion option on mutateRecord(), deleteRecord()
 * and every other mutation that bumps a version.
 *
 * The write options that describe storage rather than the request are
 * omitted from the methods below rather than dropped inside them, so the
 * signature says what travels: the server writes its own version snapshot
 * and its own journal entry from the change it applies, and decides its
 * own version bump the same way. See docs/spec/versioning.md § Storage per
 * adapter.
 */

import { StackError, StackBadRequestError, assertOneSurface } from '@haverstack/core';
import type {
  JournalQuery,
  VersionsQuery,
  RecordJournalEntry,
  StackRecord,
  PutAttachmentOptions,
  StackType,
  TypeId,
  RecordVersion,
  StackQuery,
  QueryResult,
  Association,
  AssociationEdit,
  RecordId,
  FileId,
  EntityId,
  RecordChange,
  RecordChangeSet,
  StackCapabilities,
  AppManifest,
  InstallContent,
  SubscribeOptions,
} from '@haverstack/core';
import {
  OwnerMismatchError,
  assertQueryCapabilities,
  assertSortCapability,
  assertValidAssociationFilters,
  filtersContent,
} from '@haverstack/core/adapter';
import type { StackAdapter } from '@haverstack/core/adapter';
import { assertQueryTravels } from '@haverstack/core/wire';
import type { DidCredential } from '@haverstack/core/wire';
import {
  isWireError,
  deserializeError,
  errorForStatus,
  isProtocolCompatible,
  isValidCursor,
  supportsChangeFeed,
  supportsInstallRequests,
  WIRE_ERROR_STATUS,
  supportsDidChallenge,
  CHANGE_FRAME_READY,
  CHANGE_FRAME_RECORD,
  CHANGE_FRAME_RESET,
  WIRE_PROTOCOL_VERSION,
  normalizeCapabilities,
} from '@haverstack/wire-types';
import type {
  WireRecord,
  WireQueryResponse,
  WireType,
  WireVersion,
  WireRecordChange,
  WireJournalResponse,
  WireVersionsResponse,
  WireReadyFrame,
  DiscoveryChanges,
  DiscoveryResponse,
  WireInstallResponse,
} from '@haverstack/wire-types';
import {
  APIAdapterError,
  APIAdapterAuthError,
  APIAdapterCapabilityError,
  APIAdapterVersionError,
  APIAdapterHandshakeError,
  APIAdapterReauthError,
  APIAdapterInsecureUrlError,
  APIAdapterAuthUnsupportedError,
} from './errors.js';
import { performHandshake } from './handshake.js';
import { withParams, buildQueryParams, buildChangeParams } from './params.js';
import { parseRecord, parseType, parseVersion, parseJournalEntry, parseChange } from './parse.js';
import { SseDecoder } from './sse.js';
import type { SseFrame } from './sse.js';
import {
  isLoopbackUrl,
  pathSegment,
  fetchOrThrow,
  authHeaders,
  readJsonBody,
  parseJsonBody,
  requireRecordBody,
  requireBody,
  successBody,
  requireNullableBody,
} from './transport.js';

// -------------------------------------------------------
// Public option types
// -------------------------------------------------------

/** What `APIAdapter.requestInstall()` resolves to. */
export type InstallRequestResult =
  | { status: 'pending' }
  | { status: 'installed'; install: StackRecord & { content: InstallContent } };

export type APIAdapterOpenOptions = {
  /** Base URL of the stack server e.g. "https://example.com". Trailing slash is stripped. */
  url: string;
  /** Bearer token issued by the stack server. Omit for unauthenticated access. */
  token?: string;
  /**
   * The DID this client expects to own the stack at `url`. Asserted, never
   * used to create: open() throws OwnerMismatchError when discovery reports
   * anything else. Omit when the URL is the only expectation you have.
   */
  ownerEntityId?: EntityId;
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

/**
 * `bytes` is sent as-is under the Content-Type in `headers`, in place of a
 * JSON body. The caller names it because a typed array from another realm
 * is not `instanceof Uint8Array`, so the body's type cannot tell.
 */
type RequestOptions = {
  nullOn404?: boolean;
  ifMatch?: number;
  bytes?: Uint8Array;
  headers?: Record<string, string>;
};

// -------------------------------------------------------
// Change feed reconnection
// -------------------------------------------------------

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
 * reconnects.
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
// APIAdapter
// -------------------------------------------------------

export class APIAdapter implements StackAdapter {
  readonly capabilities: StackCapabilities;
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
    capabilities: StackCapabilities,
    /** The feed discovery advertised, if any. Absent means the server offers none. */
    private readonly changeFeed: DiscoveryChanges | undefined,
    /** Whether discovery advertised `POST /installs`. */
    private readonly installRequests: boolean,
  ) {
    this.capabilities = capabilities;
    this.ownerEntityId = ownerEntityId;
    this.timezone = timezone;
  }

  /**
   * Connect to a remote stack server, reading its discovery document before
   * returning. Throws APIAdapterAuthError on 401, APIAdapterConnectionError
   * when the server is unreachable, and OwnerMismatchError when
   * `ownerEntityId` disagrees with the owner discovery reports.
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

    const discovery = await successBody<DiscoveryResponse>(res, 'GET', '/.well-known/stack');

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
    if (opts.ownerEntityId !== undefined && discovery.entityId !== opts.ownerEntityId) {
      throw new OwnerMismatchError(
        opts.ownerEntityId,
        discovery.entityId,
        `the server at "${baseUrl}"`,
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
      supportsInstallRequests(discovery),
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
      // Only a refused credential is a failed renewal. A dropped connection
      // or a server in trouble surfaces as itself, so a caller can tell it
      // may clear — the change feed reconnects through one.
      if (!(err instanceof APIAdapterHandshakeError)) throw err;
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

  /**
   * `null` only for a 404 the caller opted into reading as absence;
   * `undefined` for a response with no body. Which of those an endpoint
   * may answer is for the typed helpers below to judge.
   */
  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    { nullOn404 = false, ifMatch, bytes, headers: extra }: RequestOptions = {},
  ): Promise<T | null | undefined> {
    const res = await this.send(`${this.baseUrl}${path}`, (token) => {
      const headers = authHeaders(token, extra);
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      // Opt-in optimistic-concurrency precondition (see Stack's ifVersion).
      // A mismatch gets a 412 with a version_conflict wire body, which
      // errorForResponse() below reconstructs as StackVersionConflictError.
      if (ifMatch !== undefined) headers['If-Match'] = `"${ifMatch}"`;
      const encoded = bytes ?? (body !== undefined ? JSON.stringify(body) : undefined);
      return { method, headers, body: encoded as BodyInit | undefined };
    });

    if (res.status === 404 && nullOn404) return null;
    if (!res.ok) throw await this.errorForResponse(res, method, path);
    if (res.status === 204) return undefined;

    return (await parseJsonBody(res, method, path)) as T | null | undefined;
  }

  /** A mutation that bumps `version`, owed the record it produced. */
  private async requestRecord(
    method: string,
    path: string,
    body?: unknown,
    opts: Omit<RequestOptions, 'nullOn404'> = {},
  ): Promise<StackRecord> {
    const raw = await this.request<WireRecord>(method, path, body, opts);
    return requireRecordBody(raw, `${method} ${path}`);
  }

  /** A read with no "absent" case, owed its body. */
  private async requestBody<T>(method: string, path: string, body?: unknown): Promise<T> {
    return requireBody(await this.request<T>(method, path, body), `${method} ${path}`);
  }

  /** A read that answers "not there" with a 404, returned as null. */
  private async requestNullable<T>(path: string): Promise<T | null> {
    const raw = await this.request<T>('GET', path, undefined, { nullOn404: true });
    return requireNullableBody(raw, `GET ${path}`);
  }

  private async requestBinary(path: string): Promise<Uint8Array> {
    const res = await this.send(`${this.baseUrl}${path}`, (token) => ({
      headers: authHeaders(token),
    }));

    if (!res.ok) throw await this.errorForResponse(res, 'GET', path);
    return new Uint8Array(await res.arrayBuffer());
  }

  // -------------------------------------------------------
  // Records
  // -------------------------------------------------------

  async createRecord(record: StackRecord): Promise<StackRecord> {
    return this.requestRecord('POST', '/records', record);
  }

  // Always opts into tombstones: hiding them is Stack.get()'s policy, and
  // the verbs that refuse or undelete one have to be able to find it.
  async getRecord(id: RecordId): Promise<StackRecord | null> {
    const raw = await this.requestNullable<WireRecord>(
      `/records/${pathSegment(id)}?includeDeleted=true`,
    );
    return raw ? parseRecord(raw) : null;
  }

  async mutateRecord(
    id: RecordId,
    changes: RecordChangeSet,
    opts: { ifVersion?: number } = {},
  ): Promise<StackRecord> {
    // The change set travels as-is — no record fields (typeId, version,
    // updatedAt) ride along. The server applies it against its own current
    // state and assigns the new version/updatedAt; the response is
    // authoritative. One If-Match fences the whole set.
    return this.requestRecord('PATCH', `/records/${pathSegment(id)}`, changes, {
      ifMatch: opts.ifVersion,
    });
  }

  /**
   * Present this app's manifest for the owner to approve, as the key this
   * adapter authenticated with. `pending` until the owner approves this
   * manifest for this key; `installed`, with the `_install` record, once
   * applying it would change nothing. Refused locally when the server does
   * not advertise install requests. See docs/spec/wire-format.md § Installs.
   */
  async requestInstall(manifest: AppManifest): Promise<InstallRequestResult> {
    if (!this.installRequests) {
      throw new APIAdapterCapabilityError(
        'installs',
        `Server at "${this.baseUrl}" does not take install requests; ask its owner to install ` +
          'the app another way.',
      );
    }
    const raw = await this.request<WireInstallResponse>('POST', '/installs', { manifest });
    if (raw?.status === 'pending') return { status: 'pending' };
    if (raw?.status === 'installed' && raw.install) {
      return {
        status: 'installed',
        install: parseRecord(raw.install) as StackRecord & { content: InstallContent },
      };
    }
    throw new APIAdapterError(
      'POST /installs answered with neither a pending nor an installed body',
    );
  }

  async commitMigration(
    id: RecordId,
    toTypeId: TypeId,
    content: Record<string, unknown>,
    opts: { ifVersion?: number } = {},
  ): Promise<StackRecord> {
    return this.requestRecord(
      'POST',
      `/records/${pathSegment(id)}/migrate`,
      { toTypeId, content },
      { ifMatch: opts.ifVersion },
    );
  }

  /**
   * A soft delete answers with the record it produced; a purge bumps
   * no version and answers with the record it destroyed, which is where
   * the files the purge stranded are read from. Null is reserved for a
   * purge that found nothing, the same shape a local adapter reports.
   * See docs/spec/wire-format.md § Records.
   */
  async deleteRecord(
    id: RecordId,
    opts: { purge?: boolean; ifVersion?: number } = {},
  ): Promise<StackRecord | null> {
    const path = opts.purge
      ? `/records/${pathSegment(id)}?purge=true`
      : `/records/${pathSegment(id)}`;
    const raw = await this.request<WireRecord>('DELETE', path, undefined, {
      ifMatch: opts.ifVersion,
      // An unconditional purge of a record that isn't there purged
      // nothing, which is not an error — the same answer the local
      // adapters give by returning null. A CAS is a real precondition, so
      // its 404 is left to throw.
      ...(opts.purge && opts.ifVersion === undefined && { nullOn404: true }),
    });
    return raw === null ? null : requireRecordBody(raw, `DELETE ${path}`);
  }

  async undeleteRecord(id: RecordId, opts: { ifVersion?: number } = {}): Promise<StackRecord> {
    return this.requestRecord('POST', `/records/${pathSegment(id)}/undelete`, undefined, {
      ifMatch: opts.ifVersion,
    });
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
    // A malformed association filter is a caller error, not a missing
    // capability, so this one travels as the StackBadRequestError it is —
    // refused here rather than encoded into query params a server would
    // have to reject.
    assertValidAssociationFilters(query.filter);
    // Likewise for the two fields with no wire encoding, and before the
    // branch below rather than inside it: the query body carries them to a
    // server that answers 400, while the search params have nowhere to put
    // them, so encoding them here would let the server's content reach
    // decide whether a family query is refused or silently widened.
    assertQueryTravels(query);

    let body: WireQueryResponse;
    if (filtersContent(this.capabilities)) {
      // POST /records/query supports the full query shape including content field filters
      body = await this.requestBody<WireQueryResponse>('POST', '/records/query', query);
    } else {
      // A server reaching no content only exposes GET /records
      body = await this.requestBody<WireQueryResponse>(
        'GET',
        withParams('/records', buildQueryParams(query)),
      );
    }

    return {
      records: body.records.map(parseRecord),
      cursor: body.cursor,
    };
  }

  // -------------------------------------------------------
  // Associations
  // -------------------------------------------------------

  /**
   * One storage primitive, two endpoints: authority and data never share a
   * call, so the element's own kind picks the surface it travels on. A
   * permission sent to the association endpoint is refused by any server
   * built on `ScopedStack`, which is the partition doing its job.
   * See docs/spec/access-control.md § Storage unifies; the API does not.
   */
  private static associationPath(association: Association | undefined): string {
    return association?.kind === 'permission' || association?.kind === 'anyone'
      ? 'permissions'
      : 'associations';
  }

  /**
   * No `If-Match` — amendAssociations() never bumps `version`, so
   * there's nothing an `ifVersion` precondition could guard here. See
   * docs/spec/versioning.md § Version history.
   */
  async amendAssociations(id: RecordId, changes: AssociationEdit[]): Promise<StackRecord> {
    assertOneSurface(changes);
    const path = `/records/${pathSegment(id)}/${APIAdapter.associationPath(changes[0]?.association)}`;
    return this.requestRecord('POST', path, { changes });
  }

  // -------------------------------------------------------
  // Versions
  // -------------------------------------------------------

  /**
   * Reads the window the caller asked for, across as many requests as the
   * server's own page cap takes. A server may answer a page shorter than
   * the `limit` asked for, and a caller reconstructing a full history would
   * silently get a prefix if this returned the first page. `cursor` is the
   * only end-of-log signal, exactly as it is on a query.
   */
  private async readPages<W extends { cursor: number | null }, R, T>(
    path: string,
    opts: {
      cursorParam: string;
      cursor: number | undefined;
      limit: number | undefined;
      items: (body: W) => R[];
      parse: (raw: R) => T;
      /** Whether `next` lands somewhere the read from `prev` has not been. */
      advances: (next: number, prev: number) => boolean;
    },
  ): Promise<T[]> {
    const { cursorParam, limit, items, parse, advances } = opts;
    const out: T[] = [];
    let cursor = opts.cursor;
    for (;;) {
      // Asks only for what is still outstanding, so a server honoring the
      // limit exactly answers a bounded read in one request.
      const remaining = limit === undefined ? undefined : limit - out.length;
      if (remaining !== undefined && remaining <= 0) break;
      const params = new URLSearchParams();
      if (cursor !== undefined) params.set(cursorParam, String(cursor));
      if (remaining !== undefined) params.set('limit', String(remaining));
      const body = await this.requestBody<W>('GET', withParams(path, params));
      const page = items(body);
      // Appended one at a time rather than spread: a spread is an argument
      // list, and a page may arrive without a ceiling.
      for (const raw of page) out.push(parse(raw));
      if (page.length === 0) break;
      // A server that omits a cursor, repeats one, or mints one
      // unconditionally ends the read here rather than spinning on it.
      if (
        typeof body.cursor !== 'number' ||
        (cursor !== undefined && !advances(body.cursor, cursor))
      ) {
        break;
      }
      cursor = body.cursor;
    }
    // `limit` is this method's own ceiling, not a request the server is
    // trusted to have honored: a page longer than the one asked for would
    // otherwise hand the caller more than the contract allows.
    return limit === undefined ? out : out.slice(0, limit);
  }

  /** See docs/spec/wire-format.md § Versions. */
  async getVersions(id: RecordId, query: VersionsQuery = {}): Promise<RecordVersion[]> {
    return this.readPages(`/records/${pathSegment(id)}/versions`, {
      cursorParam: 'beforeVersion',
      cursor: query.beforeVersion,
      limit: query.limit,
      items: (body: WireVersionsResponse) => body.versions,
      parse: parseVersion,
      // Newest first, so the cursor has to move strictly older.
      advances: (next, prev) => next < prev,
    });
  }

  /**
   * Unbounded when `limit` is omitted — the one read with no ceiling,
   * which is why a server needs the freedom to answer it in pages.
   * See docs/spec/wire-format.md § Journal.
   */
  async getJournal(id: RecordId, query: JournalQuery = {}): Promise<RecordJournalEntry[]> {
    return this.readPages(`/records/${pathSegment(id)}/journal`, {
      cursorParam: 'afterSeq',
      cursor: query.afterSeq,
      limit: query.limit,
      items: (body: WireJournalResponse) => body.entries,
      parse: parseJournalEntry,
      advances: (next, prev) => next > prev,
    });
  }

  async getVersion(id: RecordId, version: number): Promise<RecordVersion | null> {
    const raw = await this.requestNullable<WireVersion>(
      `/records/${pathSegment(id)}/versions/${pathSegment(version)}`,
    );
    return raw ? parseVersion(raw) : null;
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
    opts: { ifVersion?: number } = {},
  ): Promise<StackRecord> {
    return this.requestRecord(
      'POST',
      `/records/${pathSegment(id)}/restore/${pathSegment(version)}`,
      undefined,
      { ifMatch: opts.ifVersion },
    );
  }

  // -------------------------------------------------------
  // Types
  // -------------------------------------------------------

  async saveType(type: StackType): Promise<void> {
    await this.request<void>('POST', '/types', type);
  }

  async getType(id: TypeId): Promise<StackType | null> {
    const raw = await this.requestNullable<WireType>(`/types/${pathSegment(id)}`);
    return raw ? parseType(raw) : null;
  }

  async listTypes(): Promise<StackType[]> {
    return (await this.requestBody<WireType[]>('GET', '/types')).map(parseType);
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
  async putBlob(_data: Uint8Array): Promise<FileId> {
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
    const params = new URLSearchParams();
    if (appId) params.set('appId', appId);
    const headers: Record<string, string> = { 'Content-Type': mimeType };
    if (filename) {
      headers['Content-Disposition'] =
        `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`;
    }
    return this.requestRecord('POST', withParams('/attachments', params), undefined, {
      bytes: data,
      headers,
    });
  }

  async getBlob(fileId: FileId): Promise<Uint8Array> {
    return this.requestBinary(`/attachments/${pathSegment(fileId)}`);
  }

  async deleteBlob(fileId: FileId): Promise<void> {
    await this.request<void>('DELETE', `/attachments/${pathSegment(fileId)}`);
  }

  // -------------------------------------------------------
  // Change feed
  // -------------------------------------------------------

  /**
   * Relay the server's change feed. Resolves on the server's `ready` frame,
   * so subscribe-then-query is gap-free. Reconnecting is invisible to the
   * subscriber while the cursor closes the gap; `onReset` reports a gap it
   * could not close, which reconciling by query repairs.
   * See docs/spec/change-feed.md.
   */
  async subscribeChanges(
    opts: SubscribeOptions,
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
    if (opts.since !== undefined && !isValidCursor(opts.since)) {
      throw new APIAdapterError(
        `Resume cursor "${opts.since}" is not framable (unreserved base64url characters only).`,
      );
    }

    const controller = new AbortController();
    const url = `${this.baseUrl}${withParams('/changes', buildChangeParams(opts))}`;

    let stopped = false;
    let settled = false;
    let cursor = opts.since;

    let onLive: () => void;
    let onFailed: (err: unknown) => void;
    const live = new Promise<void>((resolve, reject) => {
      onLive = resolve;
      onFailed = reject;
    });

    const dispatch = (frame: SseFrame, head: string | undefined): void => {
      // A frame id is a stream position whatever the frame says, so an
      // unrecognized name still advances the cursor. One outside the
      // framable charset is discarded rather than echoed into a header.
      if (frame.id !== undefined && isValidCursor(frame.id)) cursor = frame.id;

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
          cursor = head;
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
    dispatch: (frame: SseFrame, head: string | undefined) => void,
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

    const decoder = new SseDecoder();
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        for (const frame of decoder.push(value)) {
          if (frame.event === CHANGE_FRAME_READY && head === undefined) {
            // A malformed ready payload costs the reset fallback its head
            // cursor, not the connection: treat the head as unknown. It is
            // charset-checked like a frame id, since it becomes the
            // Last-Event-ID fetch would refuse on every reconnect.
            try {
              const ready = (JSON.parse(frame.data || '{}') as WireReadyFrame).cursor;
              head = ready !== undefined && isValidCursor(ready) ? ready : undefined;
            } catch {
              head = undefined;
            }
          }
          dispatch(frame, head);
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
}
