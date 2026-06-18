import type {
  StackAdapter,
  StackRecord,
  StackType,
  TypeId,
  RecordVersion,
  StackQuery,
  QueryResult,
  Association,
  AdapterCapabilities,
  AttachmentMeta,
} from './types.js';

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

  readonly records = new Map<string, StackRecord>();
  readonly order: string[] = [];
  readonly versions = new Map<string, RecordVersion[]>();
  readonly types = new Map<string, StackType>();
  readonly config: Map<string, string>;

  constructor(initialConfig: Record<string, string> = {}) {
    this.config = new Map(Object.entries(initialConfig));
  }

  async getConfig(key: string) {
    return this.config.get(key) ?? null;
  }
  async setConfig(key: string, value: string) {
    this.config.set(key, value);
  }

  async createRecord(record: StackRecord) {
    this.records.set(record.id, { ...record });
    this.order.push(record.id);
    return record;
  }

  async getRecord(id: string) {
    return this.records.get(id) ?? null;
  }

  async updateRecord(id: string, changes: Partial<StackRecord>) {
    const existing = this.records.get(id);
    if (!existing) throw new Error(`Not found: ${id}`);
    const updated = { ...existing, ...changes };
    this.records.set(id, updated);
    return updated;
  }

  async deleteRecord(id: string, opts: { hard?: boolean } = {}) {
    if (opts.hard) {
      this.records.delete(id);
      this.order.splice(this.order.indexOf(id), 1);
    } else {
      const record = this.records.get(id);
      if (record) this.records.set(id, { ...record, deletedAt: new Date() });
    }
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
    this.records.set(id, { ...record, associations: [...assocs, association] });
  }

  async dissociate(id: string, association: Association) {
    const record = this.records.get(id);
    if (!record) throw new Error(`Not found: ${id}`);
    const assocs = (record.associations ?? []).filter(
      (a) => !(a.kind === association.kind && a.label === association.label),
    );
    this.records.set(id, { ...record, associations: assocs });
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

  async saveType(type: StackType) {
    this.types.set(type.id, type);
  }
  async getType(id: TypeId) {
    return this.types.get(id) ?? null;
  }
  async listTypes() {
    return [...this.types.values()];
  }

  async putAttachment(_data: Uint8Array, _mimeType: string) {
    return 'file-123';
  }
  async getAttachment(_fileId: string): Promise<Uint8Array> {
    return new Uint8Array();
  }
  async getAttachmentMeta(_fileId: string): Promise<AttachmentMeta | null> {
    return null;
  }
  async deleteAttachment(_fileId: string) {}

  flush?: () => Promise<void>;
  close?: () => Promise<void>;
}
