import type {
  StackAdapter,
  StackRecord,
  StackType,
  TypeId,
  RecordVersion,
  ActorOptions,
  StackQuery,
  QueryResult,
  RecordFilter,
  Association,
  Permission,
  AdapterCapabilities,
  BlobFileInfo,
} from './types.js';
import { SYSTEM_TYPES } from './types.js';
import { applyMergePatch } from './merge.js';
import {
  StackVersionConflictError,
  StackConflictError,
  StackNotFoundError,
  parseContentFilterKey,
  targetEqual,
} from './stack.js';

/** An array stands for its elements; anything else stands for itself. */
const spreadValue = (value: unknown): unknown[] => (Array.isArray(value) ? value : [value]);

/**
 * Every value reachable by walking `segments`, spreading arrays
 * element-wise at each step — the same walk sqlite-shared's
 * contentPathExists() performs in SQL, and the reason a filter answers the
 * same question against either. An empty result means the path reaches
 * nothing, which is what a `null` filter value matches.
 * See docs/spec/data-model.md § Nested content paths.
 */
const valuesAtContentPath = (content: Record<string, unknown>, segments: string[]): unknown[] => {
  let current: unknown[] = [content];
  for (const segment of segments) {
    const next: unknown[] = [];
    for (const value of current) {
      for (const item of spreadValue(value)) {
        if (typeof item !== 'object' || item === null || Array.isArray(item)) continue;
        if (Object.hasOwn(item, segment)) next.push((item as Record<string, unknown>)[segment]);
      }
    }
    current = next;
  }
  // The leaf spreads too, so a filter on `tags` matches a record whose
  // `tags` array contains the value.
  return current.flatMap(spreadValue);
};

/**
 * In-memory StackAdapter with offset-based cursor pagination. Implements
 * the full RecordFilter shape (mirroring sqlite-shared's buildWhereClause)
 * so permission logic under test exercises real predicates. Declares
 * `contentFieldQuery` and `nestedContentQuery`, as every local adapter
 * must; tests needing the capability-gated paths use
 * IncapableMemoryAdapter below.
 */
export class MemoryAdapter implements StackAdapter {
  readonly capabilities: AdapterCapabilities = {
    fullTextSearch: false,
    contentFieldQuery: true,
    nestedContentQuery: true,
    sortableFields: ['createdAt', 'updatedAt', 'version'],
    maxAttachmentBytes: null,
    maxContentBytes: null,
  };

  readonly ownerEntityId: string;
  readonly timezone: string | undefined;

  readonly records = new Map<string, StackRecord>();
  readonly order: string[] = [];
  readonly versions = new Map<string, RecordVersion[]>();
  readonly types = new Map<string, StackType>();
  readonly blobs = new Map<string, { data: Uint8Array; modifiedAt: Date }>();

  constructor({
    ownerEntityId = '',
    timezone,
  }: { ownerEntityId?: string; timezone?: string } = {}) {
    this.ownerEntityId = ownerEntityId;
    this.timezone = timezone;
  }

  async createRecord(record: StackRecord) {
    if (this.records.has(record.id)) {
      throw new StackConflictError(`Record already exists: "${record.id}"`);
    }
    this.records.set(record.id, { ...record });
    this.order.push(record.id);
    return record;
  }

  async getRecord(id: string) {
    return this.records.get(id) ?? null;
  }

  /**
   * Advance a record one version, restamping the actor. An absent actor
   * clears the previous one rather than inheriting it — an unscoped write
   * names no requester, and carrying the last one forward would attribute
   * it to whoever happened to touch the record before.
   */
  private bump(record: StackRecord, actor: ActorOptions = {}): StackRecord {
    const { updatedBy: _by, updatedVia: _via, ...rest } = record;
    return {
      ...rest,
      version: record.version + 1,
      updatedAt: new Date(),
      ...(actor.updatedBy && { updatedBy: actor.updatedBy }),
      ...(actor.updatedVia && { updatedVia: actor.updatedVia }),
    };
  }

  /** Opt-in CAS check mirroring the real adapters' expectedVersion contract. */
  private checkExpectedVersion(record: StackRecord, expectedVersion: number | undefined): void {
    if (expectedVersion === undefined || record.version === expectedVersion) return;
    throw new StackVersionConflictError(
      `Record "${record.id}" is at version ${record.version}, expected ${expectedVersion}`,
      record.id,
      expectedVersion,
      record.version,
    );
  }

  /**
   * True if any top-level file-ref field in the record's registered type
   * schema currently holds this fileId — the content-reference half of
   * attachmentFileId matching. Mirrors sqlite-shared's file_refs index,
   * computed on the fly since MemoryAdapter has no persisted index.
   */
  private hasFileRefTo(record: StackRecord, fileId: string): boolean {
    const schema = this.types.get(record.typeId)?.schema;
    if (!schema) return false;
    const content = record.content as Record<string, unknown>;
    return Object.entries(schema).some(
      ([field, def]) => def.kind === 'file-ref' && content[field] === fileId,
    );
  }

  async patchContent(
    id: string,
    patch: Record<string, unknown | null>,
    opts: { expectedVersion?: number; snapshot?: RecordVersion } & ActorOptions = {},
  ) {
    const existing = this.records.get(id);
    if (!existing) throw new Error(`Not found: ${id}`);
    this.checkExpectedVersion(existing, opts.expectedVersion);
    if (opts.snapshot) this.snapshotBeforeMutation(id, opts.snapshot);
    const updated = this.bump(
      { ...existing, content: applyMergePatch(existing.content, patch) },
      opts,
    );
    this.records.set(id, updated);
    return updated;
  }

  async deleteRecord(
    id: string,
    opts: {
      hard?: boolean;
      expectedVersion?: number;
      snapshot?: RecordVersion;
    } & ActorOptions = {},
  ) {
    const record = this.records.get(id);
    if (!record) {
      // A hard delete with nothing to fence is the one case the SQL
      // adapters answer silently; every other shape of this call reports a
      // record that isn't there, and a fixture that shrugged instead would
      // pass tests the real adapters fail.
      if (opts.hard && opts.expectedVersion === undefined) return null;
      throw new StackNotFoundError(`Record not found: "${id}"`);
    }
    this.checkExpectedVersion(record, opts.expectedVersion);
    if (opts.hard) {
      this.records.delete(id);
      this.order.splice(this.order.indexOf(id), 1);
      return record;
    }
    if (opts.snapshot) this.snapshotBeforeMutation(id, opts.snapshot);
    const deleted = this.bump({ ...record, deletedAt: new Date() }, opts);
    this.records.set(id, deleted);
    return deleted;
  }

  async undeleteRecord(
    id: string,
    opts: { expectedVersion?: number; snapshot?: RecordVersion } & ActorOptions = {},
  ) {
    const record = this.records.get(id);
    if (!record) throw new Error(`Not found: ${id}`);
    this.checkExpectedVersion(record, opts.expectedVersion);
    if (opts.snapshot) this.snapshotBeforeMutation(id, opts.snapshot);
    const { deletedAt: _deletedAt, ...rest } = record;
    const updated = this.bump(rest as StackRecord, opts);
    this.records.set(id, updated);
    return updated;
  }

  /** Cursor is a stringified offset into insertion order. */
  async queryRecords(query: StackQuery): Promise<QueryResult> {
    const f = query.filter ?? {};
    let results = this.order.map((id) => this.records.get(id)!);
    // _config is addressable only by ID (getRecord), never returned by a
    // generic query — mirroring the real SQL adapters' WHERE exclusion.
    results = results.filter((r) => r.id !== SYSTEM_TYPES.CONFIG);
    if (!f.includeDeleted) results = results.filter((r) => !r.deletedAt);
    if (!f.includeUnlisted) results = results.filter((r) => !r.unlistedAt);
    if (f.typeId) {
      const ids = Array.isArray(f.typeId) ? f.typeId : [f.typeId];
      results = results.filter((r) => ids.includes(r.typeId));
    }
    if (f.parentId !== undefined) {
      results =
        f.parentId === null
          ? results.filter((r) => !r.parentId)
          : results.filter((r) => r.parentId === f.parentId);
    }
    if (f.appId !== undefined) {
      const ids = Array.isArray(f.appId) ? f.appId : [f.appId];
      results = results.filter((r) => r.appId !== undefined && ids.includes(r.appId));
    }
    if (f.entityId !== undefined) {
      const ids = Array.isArray(f.entityId) ? f.entityId : [f.entityId];
      results = results.filter((r) => r.entityId !== undefined && ids.includes(r.entityId));
    }
    if (f.principalId !== undefined) {
      const ids = Array.isArray(f.principalId) ? f.principalId : [f.principalId];
      results = results.filter((r) => r.principalId !== undefined && ids.includes(r.principalId));
    }
    if (f.createdAt?.after) results = results.filter((r) => r.createdAt > f.createdAt!.after!);
    if (f.createdAt?.before) results = results.filter((r) => r.createdAt < f.createdAt!.before!);
    if (f.updatedAt?.after) results = results.filter((r) => r.updatedAt > f.updatedAt!.after!);
    if (f.updatedAt?.before) results = results.filter((r) => r.updatedAt < f.updatedAt!.before!);
    if (f.tags?.length) {
      const tags = f.tags;
      results = results.filter((r) =>
        tags.every((tag) =>
          (r.associations ?? []).some((a) => a.kind === 'tag' && a.label === tag),
        ),
      );
    }
    if (f.hasAttachment) {
      results = results.filter((r) =>
        (r.associations ?? []).some((a) => a.kind === 'attachment' && a.label === f.hasAttachment),
      );
    }
    if (f.attachmentFileId) {
      const fileId = f.attachmentFileId;
      results = results.filter(
        (r) =>
          (r.associations ?? []).some((a) => a.kind === 'attachment' && a.fileId === fileId) ||
          this.hasFileRefTo(r, fileId),
      );
    }
    if (f.relatedTo) {
      const relatedTo = f.relatedTo;
      results = results.filter((r) => matchesRelatedTo(r.associations, relatedTo));
    }
    // A `null` filter value means "field absent or null" — not "match
    // nothing". Plain `===` would miss an absent field; treat both as
    // satisfying a null filter (docs/spec/data-model.md § Filter).
    if (f.content) {
      const entries = Object.entries(f.content).map(
        ([key, value]) => [parseContentFilterKey(key), value] as const,
      );
      results = results.filter((r) =>
        entries.every(([segments, value]) => {
          const found = valuesAtContentPath(r.content as Record<string, unknown>, segments);
          if (value === null || value === undefined) {
            return found.length === 0 || found.some((v) => v === null || v === undefined);
          }
          return found.some((v) => v === value);
        }),
      );
    }

    const limit = query.limit ?? 50;
    const start = query.cursor ? Number(query.cursor) : 0;
    const page = results.slice(start, start + limit);
    const nextStart = start + limit;
    const cursor = nextStart < results.length ? String(nextStart) : null;

    return { records: page, cursor, total: results.length };
  }

  async associate(
    id: string,
    association: Association,
    opts: { expectedVersion?: number; snapshot?: RecordVersion } & ActorOptions = {},
  ) {
    const record = this.records.get(id);
    if (!record) throw new Error(`Not found: ${id}`);
    this.checkExpectedVersion(record, opts.expectedVersion);
    if (opts.snapshot) this.snapshotBeforeMutation(id, opts.snapshot);
    const assocs = record.associations ?? [];
    const updated = this.bump(withAssociations(record, [...assocs, association]), opts);
    this.records.set(id, updated);
    return updated;
  }

  async dissociate(
    id: string,
    association: Association,
    opts: { expectedVersion?: number; snapshot?: RecordVersion } & ActorOptions = {},
  ) {
    const record = this.records.get(id);
    if (!record) throw new Error(`Not found: ${id}`);
    this.checkExpectedVersion(record, opts.expectedVersion);
    if (opts.snapshot) this.snapshotBeforeMutation(id, opts.snapshot);
    const assocs = (record.associations ?? []).filter((a) => !associationEqual(a, association));
    const updated = this.bump(withAssociations(record, assocs), opts);
    this.records.set(id, updated);
    return updated;
  }

  async setPermissions(
    id: string,
    permissions: Permission[],
    opts: { expectedVersion?: number; snapshot?: RecordVersion } & ActorOptions = {},
  ) {
    const record = this.records.get(id);
    if (!record) throw new Error(`Not found: ${id}`);
    this.checkExpectedVersion(record, opts.expectedVersion);
    if (opts.snapshot) this.snapshotBeforeMutation(id, opts.snapshot);
    const updated = this.bump({ ...record, permissions }, opts);
    this.records.set(id, updated);
    return updated;
  }

  async setUnlisted(
    id: string,
    unlisted: boolean,
    opts: { expectedVersion?: number; snapshot?: RecordVersion } & ActorOptions = {},
  ) {
    const record = this.records.get(id);
    if (!record) throw new Error(`Not found: ${id}`);
    this.checkExpectedVersion(record, opts.expectedVersion);
    if (opts.snapshot) this.snapshotBeforeMutation(id, opts.snapshot);
    const { unlistedAt: _unlistedAt, ...rest } = record;
    const updated = this.bump(
      unlisted ? { ...rest, unlistedAt: new Date() } : (rest as StackRecord),
      opts,
    );
    this.records.set(id, updated);
    return updated;
  }

  async getVersions(id: string) {
    return this.versions.get(id) ?? [];
  }
  async getVersion(id: string, version: number) {
    return (this.versions.get(id) ?? []).find((v) => v.version === version) ?? null;
  }

  /**
   * Loud on a (record, version) collision, mirroring the real adapters'
   * UNIQUE constraint.
   */
  private insertVersionRow(id: string, version: RecordVersion): void {
    const existing = this.versions.get(id) ?? [];
    if (existing.some((v) => v.version === version.version)) {
      throw new StackConflictError(
        `Version ${version.version} already exists for record "${id}" — a concurrent ` +
          `writer raced past this version. Use ifVersion to detect this before it happens.`,
      );
    }
    this.versions.set(id, [...existing, version]);
  }

  /**
   * Standalone snapshot write for tooling and tests — loud on any
   * collision, since nothing here is about to bump the record's version.
   * Mutating methods take a `snapshot` option instead; see
   * snapshotBeforeMutation.
   */
  async saveVersion(id: string, version: RecordVersion) {
    this.insertVersionRow(id, version);
  }

  /**
   * The snapshot half of a mutating method's atomic snapshot-then-mutate
   * step. Mirrors the real adapters' snapshotBeforeMutation (see
   * sqlite-shared/record-logic.ts for the full rationale): a collision is
   * rejected loudly, except an orphan row at the record's current version,
   * which is overwritten so the interrupted write can finally complete.
   */
  private snapshotBeforeMutation(id: string, version: RecordVersion): void {
    const existing = this.versions.get(id) ?? [];
    const collision = existing.some((v) => v.version === version.version);
    if (!collision) {
      this.versions.set(id, [...existing, version]);
      return;
    }

    const record = this.records.get(id);
    if (!record || record.version !== version.version) {
      throw new StackConflictError(
        `Version ${version.version} already exists for record "${id}" — a concurrent ` +
          `writer raced past this version. Use ifVersion to detect this before it happens.`,
      );
    }

    this.versions.set(
      id,
      existing.map((v) => (v.version === version.version ? version : v)),
    );
  }

  async restoreVersion(
    id: string,
    version: number,
    opts: { expectedVersion?: number; snapshot?: RecordVersion } & ActorOptions = {},
  ) {
    const record = this.records.get(id);
    if (!record) throw new Error(`Not found: ${id}`);
    this.checkExpectedVersion(record, opts.expectedVersion);
    const target = (this.versions.get(id) ?? []).find((v) => v.version === version);
    if (!target) throw new Error(`Version not found: ${id}@${version}`);
    if (opts.snapshot) this.snapshotBeforeMutation(id, opts.snapshot);
    const merged = { ...record, typeId: target.typeId, content: target.content };
    const withAssoc =
      target.associations !== undefined ? withAssociations(merged, target.associations) : merged;
    const updated = this.bump(withAssoc, opts);
    this.records.set(id, updated);
    return updated;
  }

  async commitMigration(
    id: string,
    toTypeId: TypeId,
    content: Record<string, unknown>,
    opts: { expectedVersion?: number; snapshot?: RecordVersion } & ActorOptions = {},
  ) {
    const record = this.records.get(id);
    if (!record) throw new Error(`Not found: ${id}`);
    this.checkExpectedVersion(record, opts.expectedVersion);
    if (opts.snapshot) this.snapshotBeforeMutation(id, opts.snapshot);
    const updated = this.bump({ ...record, typeId: toTypeId, content }, opts);
    this.records.set(id, updated);
    return updated;
  }

  async saveType(type: StackType) {
    this.types.set(type.id, type);
  }
  async getType(id: TypeId) {
    return this.types.get(id) ?? null;
  }
  async listTypes() {
    return [...this.types.values()];
  }

  /** Content-addressed, like the real adapters — needed so file-ref values (SHA-256 hex) validate. */
  async putAttachment(data: Uint8Array): Promise<string> {
    const hashBuffer = await crypto.subtle.digest('SHA-256', data as BufferSource);
    const fileId = Array.from(new Uint8Array(hashBuffer))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    if (!this.blobs.has(fileId)) {
      this.blobs.set(fileId, { data, modifiedAt: new Date() });
    }
    return fileId;
  }
  async getAttachment(fileId: string): Promise<Uint8Array> {
    const blob = this.blobs.get(fileId);
    if (!blob) throw new StackNotFoundError(`Attachment not found: "${fileId}"`);
    return blob.data;
  }
  async deleteAttachment(fileId: string) {
    this.blobs.delete(fileId);
  }
  // Declared as an optional field (not a fixed method) so a test subclass
  // can override it to `undefined`, simulating an adapter that doesn't
  // implement this capability (see stack.test.ts's NoListFilesAdapter).
  listFiles?: () => Promise<BlobFileInfo[]> = async () => {
    return [...this.blobs.entries()].map(([fileId, blob]) => ({
      fileId,
      size: blob.data.byteLength,
      modifiedAt: blob.modifiedAt,
    }));
  };

  flush?: () => Promise<void>;
  close?: () => Promise<void>;
}

/**
 * A MemoryAdapter that declares both content-query capabilities false,
 * simulating the one legitimate case: a wire adapter whose server
 * declined them
 * (docs/spec/adapters.md § Adapter capabilities). For exercising Stack's
 * capability-gated fallbacks and the fail-loud assertQueryCapabilities
 * check in tests; not a stand-in for a real local adapter.
 */
export class IncapableMemoryAdapter extends MemoryAdapter {
  override readonly capabilities: AdapterCapabilities = {
    fullTextSearch: false,
    contentFieldQuery: false,
    nestedContentQuery: false,
    sortableFields: ['createdAt', 'updatedAt', 'version'],
    maxAttachmentBytes: null,
    maxContentBytes: null,
  };
}

/**
 * Sets a record's associations, omitting the key entirely when empty —
 * mirroring the SQL adapters' rowToRecord, so the same mutation sequence
 * produces identically-shaped records on the test double and real storage.
 */
function withAssociations(record: StackRecord, associations: Association[]): StackRecord {
  const { associations: _drop, ...rest } = record;
  return associations.length ? { ...rest, associations } : (rest as StackRecord);
}

/**
 * Mirrors Stack's private associationEqual(): identity is (kind, label) plus
 * fileId for attachments / the target for relationships.
 */
function associationEqual(a: Association, b: Association): boolean {
  if (a.kind !== b.kind || a.label !== b.label) return false;
  if (a.kind === 'attachment' && b.kind === 'attachment') return a.fileId === b.fileId;
  if (a.kind === 'relationship' && b.kind === 'relationship') {
    return targetEqual(a.target, b.target);
  }
  return true;
}

/**
 * Mirrors sqlite-shared's relatedTo predicate: a bare label matches every
 * target under it, and an external target with no `id` matches its whole
 * namespace.
 */
function matchesRelatedTo(
  associations: Association[] | undefined,
  filter: NonNullable<RecordFilter['relatedTo']>,
): boolean {
  return (associations ?? []).some((a) => {
    if (a.kind !== 'relationship') return false;
    if (filter.label !== undefined && a.label !== filter.label) return false;
    const want = filter.target;
    if (!want) return true;
    const got = a.target;
    if (got.scope !== want.scope) return false;
    if (want.scope === 'record' && got.scope === 'record') {
      return got.recordId === want.recordId && (got.stackUrl ?? '') === (want.stackUrl ?? '');
    }
    if (want.scope === 'entity' && got.scope === 'entity') return got.entityId === want.entityId;
    if (want.scope === 'external' && got.scope === 'external') {
      return got.ns === want.ns && (want.id === undefined || got.id === want.id);
    }
    return false;
  });
}
