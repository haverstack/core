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
} from './types.js';
import { applyMergePatch } from './merge.js';

/**
 * Fully functional in-memory StackAdapter with offset-based cursor pagination.
 * Intended for use in tests — import from `@haverstack/core/testing`.
 */
export class MemoryAdapter implements StackAdapter {
  readonly capabilities: AdapterCapabilities = {
    fullTextSearch: false,
    contentFieldQuery: false,
    sortableFields: ['createdAt', 'updatedAt', 'version'],
  };

  readonly ownerEntityId: string;
  readonly timezone: string;

  readonly records = new Map<string, StackRecord>();
  readonly order: string[] = [];
  readonly versions = new Map<string, RecordVersion[]>();
  readonly types = new Map<string, StackType>();

  constructor({
    ownerEntityId = '',
    timezone = 'UTC',
  }: { ownerEntityId?: string; timezone?: string } = {}) {
    this.ownerEntityId = ownerEntityId;
    this.timezone = timezone;
  }

  async createRecord(record: StackRecord) {
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

  async patchContent(id: string, patch: Record<string, unknown | null>) {
    const existing = this.records.get(id);
    if (!existing) throw new Error(`Not found: ${id}`);
    const updated = this.bump({ ...existing, content: applyMergePatch(existing.content, patch) });
    this.records.set(id, updated);
    return updated;
  }

  async deleteRecord(id: string, opts: { hard?: boolean } = {}) {
    if (opts.hard) {
      this.records.delete(id);
      this.order.splice(this.order.indexOf(id), 1);
    } else {
      const record = this.records.get(id);
      if (record) this.records.set(id, this.bump({ ...record, deletedAt: new Date() }));
    }
  }

  async undeleteRecord(id: string) {
    const record = this.records.get(id);
    if (!record) throw new Error(`Not found: ${id}`);
    const { deletedAt: _deletedAt, ...rest } = record;
    const updated = this.bump(rest as StackRecord);
    this.records.set(id, updated);
    return updated;
  }

  /** Cursor is a stringified offset into insertion order. */
  async queryRecords(query: StackQuery): Promise<QueryResult> {
    const f = query.filter ?? {};
    let results = this.order.map((id) => this.records.get(id)!);
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
    if (f.entityId !== undefined) {
      const ids = Array.isArray(f.entityId) ? f.entityId : [f.entityId];
      results = results.filter((r) => r.entityId !== undefined && ids.includes(r.entityId));
    }
    if (f.attachmentFileId) {
      results = results.filter((r) =>
        (r.associations ?? []).some(
          (a) => a.kind === 'attachment' && a.fileId === f.attachmentFileId,
        ),
      );
    }

    const limit = query.limit ?? 50;
    const start = query.cursor ? Number(query.cursor) : 0;
    const page = results.slice(start, start + limit);
    const nextStart = start + limit;
    const cursor = nextStart < results.length ? String(nextStart) : null;

    return { records: page, cursor, total: results.length };
  }

  async associate(id: string, association: Association) {
    const record = this.records.get(id);
    if (!record) throw new Error(`Not found: ${id}`);
    const assocs = record.associations ?? [];
    this.records.set(id, this.bump({ ...record, associations: [...assocs, association] }));
  }

  async dissociate(id: string, association: Association) {
    const record = this.records.get(id);
    if (!record) throw new Error(`Not found: ${id}`);
    const assocs = (record.associations ?? []).filter(
      (a) => !(a.kind === association.kind && a.label === association.label),
    );
    this.records.set(id, this.bump({ ...record, associations: assocs }));
  }

  async setPermissions(id: string, permissions: Permission[]) {
    const record = this.records.get(id);
    if (!record) throw new Error(`Not found: ${id}`);
    this.records.set(id, this.bump({ ...record, permissions }));
  }

  async getVersions(id: string) {
    return this.versions.get(id) ?? [];
  }
  async getVersion(id: string, version: number) {
    return (this.versions.get(id) ?? []).find((v) => v.version === version) ?? null;
  }
  async saveVersion(id: string, version: RecordVersion) {
    const existing = this.versions.get(id) ?? [];
    this.versions.set(id, [...existing, version]);
  }

  async restoreVersion(id: string, version: number) {
    const record = this.records.get(id);
    if (!record) throw new Error(`Not found: ${id}`);
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

  async putAttachment(_data: Uint8Array): Promise<string> {
    return 'file-123';
  }
  async getAttachment(_fileId: string): Promise<Uint8Array> {
    return new Uint8Array();
  }
  async deleteAttachment(_fileId: string) {}

  flush?: () => Promise<void>;
  close?: () => Promise<void>;
}
