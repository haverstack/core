import type {
  StackAdapter,
  StackRecord,
  StackType,
  TypeId,
  RecordVersion,
  StackQuery,
  QueryResult,
  Association,
  Permission,
  AdapterCapabilities,
  BlobFileInfo,
} from './types.js';
import { SYSTEM_TYPES } from './types.js';
import { applyMergePatch } from './merge.js';
import { StackVersionConflictError, StackConflictError } from './stack.js';

/**
 * In-memory StackAdapter with offset-based cursor pagination. Implements the
 * full RecordFilter shape (mirroring sqlite-shared's buildWhereClause) so
 * permission logic under test exercises real predicates rather than an
 * adapter that quietly ignores most filters. Intended for use in tests —
 * import from `@haverstack/core/testing`.
 *
 * Declares `contentFieldQuery: true` — a local, in-process adapter like this
 * one has no legitimate reason to decline content-field filtering (#90), so
 * this is the shape a real local adapter should have. `fullTextSearch`
 * stays `false`: no such requirement applies there, and this adapter never
 * implements `filter.search`. Tests that specifically need to exercise
 * Stack's capability-gated fallback/cursor-walk paths (or the fail-loud
 * check in `assertQueryCapabilities`, #113) should use
 * `IncapableMemoryAdapter` below instead of reaching for a `false` override
 * here.
 */
export class MemoryAdapter implements StackAdapter {
  readonly capabilities: AdapterCapabilities = {
    fullTextSearch: false,
    contentFieldQuery: true,
    sortableFields: ['createdAt', 'updatedAt', 'version'],
    maxAttachmentBytes: null,
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

  private bump(record: StackRecord): StackRecord {
    return { ...record, version: record.version + 1, updatedAt: new Date() };
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
   * attachmentFileId matching (see #63). Mirrors sqlite-shared's file_refs
   * index, computed on the fly since MemoryAdapter has no persisted index.
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
    opts: { expectedVersion?: number } = {},
  ) {
    const existing = this.records.get(id);
    if (!existing) throw new Error(`Not found: ${id}`);
    this.checkExpectedVersion(existing, opts.expectedVersion);
    const updated = this.bump({ ...existing, content: applyMergePatch(existing.content, patch) });
    this.records.set(id, updated);
    return updated;
  }

  async deleteRecord(id: string, opts: { hard?: boolean; expectedVersion?: number } = {}) {
    if (opts.hard) {
      const record = this.records.get(id);
      if (record) this.checkExpectedVersion(record, opts.expectedVersion);
      this.records.delete(id);
      this.order.splice(this.order.indexOf(id), 1);
    } else {
      const record = this.records.get(id);
      if (record) {
        this.checkExpectedVersion(record, opts.expectedVersion);
        this.records.set(id, this.bump({ ...record, deletedAt: new Date() }));
      }
    }
  }

  async undeleteRecord(id: string, opts: { expectedVersion?: number } = {}) {
    const record = this.records.get(id);
    if (!record) throw new Error(`Not found: ${id}`);
    this.checkExpectedVersion(record, opts.expectedVersion);
    const { deletedAt: _deletedAt, ...rest } = record;
    const updated = this.bump(rest as StackRecord);
    this.records.set(id, updated);
    return updated;
  }

  /** Cursor is a stringified offset into insertion order. */
  async queryRecords(query: StackQuery): Promise<QueryResult> {
    const f = query.filter ?? {};
    let results = this.order.map((id) => this.records.get(id)!);
    // _config is addressable only by ID (getRecord), never returned by a
    // generic query — mirroring the real SQL adapters' WHERE exclusion (#67).
    results = results.filter((r) => r.id !== SYSTEM_TYPES.CONFIG);
    if (!f.includeDeleted) results = results.filter((r) => !r.deletedAt);
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
      const { recordId, label } = f.relatedTo;
      results = results.filter((r) =>
        (r.associations ?? []).some(
          (a) =>
            a.kind === 'relationship' && a.recordId === recordId && (!label || a.label === label),
        ),
      );
    }
    // A `null` filter value means "field absent or null" — not "match
    // nothing" (#69). Plain `===` would miss an absent field, since
    // `undefined === null` is false; treat both as satisfying a null filter.
    if (f.content) {
      const entries = Object.entries(f.content);
      results = results.filter((r) =>
        entries.every(([key, value]) => {
          const actual = (r.content as Record<string, unknown>)[key];
          return value === null ? actual === null || actual === undefined : actual === value;
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

  async associate(id: string, association: Association, opts: { expectedVersion?: number } = {}) {
    const record = this.records.get(id);
    if (!record) throw new Error(`Not found: ${id}`);
    this.checkExpectedVersion(record, opts.expectedVersion);
    const assocs = record.associations ?? [];
    this.records.set(id, this.bump({ ...record, associations: [...assocs, association] }));
  }

  async dissociate(id: string, association: Association, opts: { expectedVersion?: number } = {}) {
    const record = this.records.get(id);
    if (!record) throw new Error(`Not found: ${id}`);
    this.checkExpectedVersion(record, opts.expectedVersion);
    const assocs = (record.associations ?? []).filter((a) => !associationEqual(a, association));
    this.records.set(id, this.bump({ ...record, associations: assocs }));
  }

  async setPermissions(
    id: string,
    permissions: Permission[],
    opts: { expectedVersion?: number } = {},
  ) {
    const record = this.records.get(id);
    if (!record) throw new Error(`Not found: ${id}`);
    this.checkExpectedVersion(record, opts.expectedVersion);
    this.records.set(id, this.bump({ ...record, permissions }));
  }

  async getVersions(id: string) {
    return this.versions.get(id) ?? [];
  }
  async getVersion(id: string, version: number) {
    return (this.versions.get(id) ?? []).find((v) => v.version === version) ?? null;
  }
  /** Loud on a (record, version) collision, mirroring the real adapters' UNIQUE constraint. */
  async saveVersion(id: string, version: RecordVersion) {
    const existing = this.versions.get(id) ?? [];
    if (existing.some((v) => v.version === version.version)) {
      throw new StackConflictError(
        `Version ${version.version} already exists for record "${id}" — a concurrent ` +
          `writer raced past this version. Use ifVersion to detect this before it happens.`,
      );
    }
    this.versions.set(id, [...existing, version]);
  }

  async restoreVersion(id: string, version: number, opts: { expectedVersion?: number } = {}) {
    const record = this.records.get(id);
    if (!record) throw new Error(`Not found: ${id}`);
    this.checkExpectedVersion(record, opts.expectedVersion);
    const target = (this.versions.get(id) ?? []).find((v) => v.version === version);
    if (!target) throw new Error(`Version not found: ${id}@${version}`);
    const updated = this.bump({
      ...record,
      typeId: target.typeId,
      content: target.content,
      ...(target.associations !== undefined && { associations: target.associations }),
    });
    this.records.set(id, updated);
    return updated;
  }

  async commitMigration(id: string, toTypeId: TypeId, content: Record<string, unknown>) {
    const record = this.records.get(id);
    if (!record) throw new Error(`Not found: ${id}`);
    const updated = this.bump({ ...record, typeId: toTypeId, content });
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
  // Deliberately lenient for fileIds never actually put (returns empty bytes,
  // not an error) — a lot of existing tests exercise permission logic with
  // synthetic fileIds that were never uploaded. Subclass and override this
  // method to test the genuinely-missing-file path (see stack.test.ts).
  async getAttachment(fileId: string): Promise<Uint8Array> {
    return this.blobs.get(fileId)?.data ?? new Uint8Array();
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
 * A `MemoryAdapter` that declares `contentFieldQuery: false` — deliberately
 * simulating the one case where that declaration is still legitimate: a
 * wire adapter whose server has declined the capability (#90). Not a stand-
 * in for a real local adapter; every actual local adapter must declare
 * `true`. Its query() still filters `content` correctly under the hood (it
 * shares MemoryAdapter's implementation), so it's precise for what it's
 * for: exercising Stack's capability-gated fallback/cursor-walk code paths
 * and the fail-loud `assertQueryCapabilities` check (#113) in tests,
 * without also losing correctness on the fallback's own filtering logic.
 */
export class IncapableMemoryAdapter extends MemoryAdapter {
  override readonly capabilities: AdapterCapabilities = {
    fullTextSearch: false,
    contentFieldQuery: false,
    sortableFields: ['createdAt', 'updatedAt', 'version'],
    maxAttachmentBytes: null,
  };
}

/**
 * Mirrors Stack's private associationEqual(): identity is (kind, label) plus
 * fileId for attachments / recordId for relationships.
 */
function associationEqual(a: Association, b: Association): boolean {
  if (a.kind !== b.kind || a.label !== b.label) return false;
  if (a.kind === 'attachment' && b.kind === 'attachment') return a.fileId === b.fileId;
  if (a.kind === 'relationship' && b.kind === 'relationship') return a.recordId === b.recordId;
  return true;
}
