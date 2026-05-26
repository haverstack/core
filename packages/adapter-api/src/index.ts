/**
 * Stack — API Adapter
 * -------------------------------------------------------
 * Implements StackAdapter over HTTP. On open(), calls the
 * discovery endpoint to populate AdapterCapabilities before
 * returning, so capabilities are available synchronously
 * once the adapter is in hand.
 *
 * Authentication uses a bearer token in the Authorization
 * header. Token issuance is server-defined and out of scope.
 *
 * v1 requires connectivity — offline queue and conflict
 * detection are deferred.
 */

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
  AdapterCapabilities,
  RecordId,
  FileId,
  Permission,
  AttachmentMeta,
} from '@haverstack/core';

// -------------------------------------------------------
// Public option types
// -------------------------------------------------------

export type APIAdapterOpenOptions = {
  /** Base URL of the stack server e.g. "https://example.com". Trailing slash is stripped. */
  url: string;
  /** Bearer token issued by the stack server. Omit for unauthenticated access. */
  token?: string;
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

// -------------------------------------------------------
// Discovery response shape
// -------------------------------------------------------

type DiscoveryResponse = {
  version: string;
  entityId: string;
  timezone?: string;
  capabilities: AdapterCapabilities;
};

// -------------------------------------------------------
// Domain object parsers (wire JSON → typed domain objects)
// -------------------------------------------------------

const fromISO = (s: string): Date => new Date(s);

const parseRecord = (raw: Record<string, unknown>): StackRecord => {
  const record: StackRecord = {
    id: raw.id as string,
    typeId: raw.typeId as string,
    createdAt: fromISO(raw.createdAt as string),
    updatedAt: fromISO(raw.updatedAt as string),
    content: raw.content as Record<string, unknown>,
    version: raw.version as number,
  };
  if (raw.parentId != null) record.parentId = raw.parentId as string;
  if (raw.entityId != null) record.entityId = raw.entityId as string;
  if (raw.appId != null) record.appId = raw.appId as string;
  if (raw.deletedAt != null) record.deletedAt = fromISO(raw.deletedAt as string);
  if (raw.permissions != null) record.permissions = raw.permissions as Permission[];
  if (raw.associations != null) record.associations = raw.associations as Association[];
  return record;
};

const parseType = (raw: Record<string, unknown>): StackType => {
  const t: StackType = {
    id: raw.id as string,
    baseId: raw.baseId as string,
    version: raw.version as number,
    name: raw.name as string,
    schema: raw.schema as TypeSchema,
    schemaHash: raw.schemaHash as string,
    createdAt: fromISO(raw.createdAt as string),
  };
  if (raw.migratesFrom != null) t.migratesFrom = raw.migratesFrom as string;
  return t;
};

const parseVersion = (raw: Record<string, unknown>): RecordVersion => {
  const v: RecordVersion = {
    version: raw.version as number,
    content: raw.content as Record<string, unknown>,
    updatedAt: fromISO(raw.updatedAt as string),
  };
  if (raw.entityId != null) v.entityId = raw.entityId as string;
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
  if (f.createdAt?.before) p.set('createdBefore', f.createdAt.before.toISOString());
  if (f.createdAt?.after) p.set('createdAfter', f.createdAt.after.toISOString());
  if (f.updatedAt?.before) p.set('updatedBefore', f.updatedAt.before.toISOString());
  if (f.updatedAt?.after) p.set('updatedAfter', f.updatedAt.after.toISOString());
  if (f.tags) for (const tag of f.tags) p.append('tag', tag);
  if (f.hasAttachment) p.set('hasAttachment', f.hasAttachment);
  if (f.relatedTo) p.set('relatedTo', f.relatedTo.recordId);
  if (f.search) p.set('search', f.search);
  if (f.includeDeleted) p.set('includeDeleted', 'true');
  if (query.sort?.field) p.set('sort', query.sort.field);
  if (query.sort?.direction) p.set('direction', query.sort.direction);
  if (query.limit) p.set('limit', String(query.limit));
  if (query.cursor) p.set('cursor', query.cursor);

  return p;
};

// -------------------------------------------------------
// APIAdapter
// -------------------------------------------------------

export class APIAdapter implements StackAdapter {
  readonly capabilities: AdapterCapabilities;

  private constructor(
    private readonly baseUrl: string,
    private readonly token: string | undefined,
    private readonly config: Map<string, string>,
    capabilities: AdapterCapabilities,
  ) {
    this.capabilities = capabilities;
  }

  /**
   * Connect to a remote stack server. Calls GET /.well-known/stack to verify
   * the server and populate AdapterCapabilities before returning.
   *
   * Throws APIAdapterAuthError on 401.
   * Throws APIAdapterConnectionError if the server is unreachable.
   */
  static async open(opts: APIAdapterOpenOptions): Promise<APIAdapter> {
    const baseUrl = opts.url.replace(/\/$/, '');
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

    const config = new Map<string, string>([
      ['entity_id', discovery.entityId],
      ['version', discovery.version],
    ]);
    if (discovery.timezone) config.set('timezone', discovery.timezone);

    return new APIAdapter(baseUrl, opts.token, config, discovery.capabilities);
  }

  // -------------------------------------------------------
  // Request helpers
  // -------------------------------------------------------

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    { nullOn404 = false }: { nullOn404?: boolean } = {},
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {};
    if (this.token) headers['Authorization'] = `Bearer ${this.token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      throw new APIAdapterConnectionError(this.baseUrl, err);
    }

    if (res.status === 401) throw new APIAdapterAuthError();
    if (res.status === 404 && nullOn404) return null as T;
    if (!res.ok) throw new APIAdapterError(`HTTP ${res.status}: ${method} ${path}`, res.status);
    if (res.status === 204) return undefined as T;
    return res.json() as Promise<T>;
  }

  private async requestBinary(path: string): Promise<Uint8Array> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {};
    if (this.token) headers['Authorization'] = `Bearer ${this.token}`;

    let res: Response;
    try {
      res = await fetch(url, { headers });
    } catch (err) {
      throw new APIAdapterConnectionError(this.baseUrl, err);
    }

    if (res.status === 401) throw new APIAdapterAuthError();
    if (!res.ok) throw new APIAdapterError(`HTTP ${res.status}: GET ${path}`, res.status);
    return new Uint8Array(await res.arrayBuffer());
  }

  private async uploadBinary(
    path: string,
    data: Uint8Array,
    mimeType: string,
    filename?: string,
  ): Promise<Record<string, unknown>> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = { 'Content-Type': mimeType };
    if (this.token) headers['Authorization'] = `Bearer ${this.token}`;
    if (filename) headers['Content-Disposition'] = `attachment; filename="${filename}"`;

    let res: Response;
    try {
      res = await fetch(url, { method: 'POST', headers, body: data as unknown as BodyInit });
    } catch (err) {
      throw new APIAdapterConnectionError(this.baseUrl, err);
    }

    if (res.status === 401) throw new APIAdapterAuthError();
    if (!res.ok) throw new APIAdapterError(`HTTP ${res.status}: POST ${path}`, res.status);
    return res.json() as Promise<Record<string, unknown>>;
  }

  // -------------------------------------------------------
  // Config
  // -------------------------------------------------------

  async getConfig(key: string): Promise<string | null> {
    return this.config.get(key) ?? null;
  }

  async setConfig(_key: string, _value: string): Promise<void> {
    throw new APIAdapterError('setConfig is not supported: server configuration is managed server-side');
  }

  // -------------------------------------------------------
  // Records
  // -------------------------------------------------------

  async createRecord(record: StackRecord): Promise<StackRecord> {
    const raw = await this.request<Record<string, unknown>>('POST', '/records', record);
    return parseRecord(raw);
  }

  async getRecord(id: RecordId): Promise<StackRecord | null> {
    const raw = await this.request<Record<string, unknown> | null>('GET', `/records/${id}`, undefined, {
      nullOn404: true,
    });
    return raw ? parseRecord(raw) : null;
  }

  async updateRecord(id: RecordId, changes: Partial<StackRecord>): Promise<StackRecord> {
    const raw = await this.request<Record<string, unknown>>('PATCH', `/records/${id}`, changes);
    return parseRecord(raw);
  }

  async deleteRecord(id: RecordId, opts: { hard?: boolean } = {}): Promise<void> {
    const path = opts.hard ? `/records/${id}?hard=true` : `/records/${id}`;
    await this.request<void>('DELETE', path);
  }

  async queryRecords(query: StackQuery): Promise<QueryResult> {
    type Envelope = { records: Record<string, unknown>[]; cursor: string | null; total: number };

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

  async associate(id: RecordId, association: Association): Promise<void> {
    await this.request<void>('POST', `/records/${id}/associations`, association);
  }

  async dissociate(id: RecordId, association: Association): Promise<void> {
    await this.request<void>('DELETE', `/records/${id}/associations`, association);
  }

  // -------------------------------------------------------
  // Versions
  // -------------------------------------------------------

  async getVersions(id: RecordId): Promise<RecordVersion[]> {
    const raw = await this.request<Record<string, unknown>[]>('GET', `/records/${id}/versions`);
    return raw.map(parseVersion);
  }

  async getVersion(id: RecordId, version: number): Promise<RecordVersion | null> {
    const raw = await this.request<Record<string, unknown> | null>(
      'GET',
      `/records/${id}/versions/${version}`,
      undefined,
      { nullOn404: true },
    );
    return raw ? parseVersion(raw) : null;
  }

  async saveVersion(_id: RecordId, _version: RecordVersion): Promise<void> {
    // The server snapshots versions automatically as a side effect of updateRecord.
    // There is no client-initiated saveVersion endpoint in the wire protocol.
  }

  // -------------------------------------------------------
  // Types
  // -------------------------------------------------------

  async saveType(type: StackType): Promise<void> {
    await this.request<void>('POST', '/types', type);
  }

  async getType(id: TypeId): Promise<StackType | null> {
    const raw = await this.request<Record<string, unknown> | null>(
      'GET',
      `/types/${encodeURIComponent(id)}`,
      undefined,
      { nullOn404: true },
    );
    return raw ? parseType(raw) : null;
  }

  async listTypes(): Promise<StackType[]> {
    const raw = await this.request<Record<string, unknown>[]>('GET', '/types');
    return raw.map(parseType);
  }

  // -------------------------------------------------------
  // Attachments
  // -------------------------------------------------------

  async putAttachment(data: Uint8Array, mimeType: string, filename?: string): Promise<FileId> {
    const result = await this.uploadBinary('/attachments', data, mimeType, filename);
    return result.fileId as string;
  }

  async getAttachment(fileId: FileId): Promise<Uint8Array> {
    return this.requestBinary(`/attachments/${fileId}`);
  }

  async deleteAttachment(fileId: FileId): Promise<void> {
    await this.request<void>('DELETE', `/attachments/${fileId}`);
  }

  async getAttachmentMeta(_fileId: FileId): Promise<AttachmentMeta | null> {
    // Attachment metadata lives on the server; this client-side adapter does not cache it.
    return null;
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
