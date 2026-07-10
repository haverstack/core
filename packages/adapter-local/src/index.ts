/**
 * Haverstack — Local Adapter
 * -------------------------------------------------------
 * Convenience StackAdapter that combines SQLiteRecordAdapter
 * (records, types, versions, associations, tokens) with
 * DiskBlobAdapter (binary attachments stored next to the DB).
 *
 * For most local use cases this is the only package you need.
 * If you want a different blob backend (e.g. S3), import
 * SQLiteRecordAdapter and DiskBlobAdapter separately and
 * compose them with combineAdapters() from @haverstack/core.
 */

import { dirname, join } from 'path';
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
  RecordId,
  FileId,
} from '@haverstack/core';
import { SQLiteRecordAdapter } from '@haverstack/record-adapter-sqljs';
import { DiskBlobAdapter } from '@haverstack/blob-adapter-disk';
import type { StackBlobAdapter } from '@haverstack/core';

export { SQLiteRecordAdapter } from '@haverstack/record-adapter-sqljs';
export type {
  SQLiteRecordInitializeOptions,
  SQLiteRecordOpenOptions,
  TokenInfo,
} from '@haverstack/record-adapter-sqljs';
export { DiskBlobAdapter } from '@haverstack/blob-adapter-disk';

// -------------------------------------------------------
// Option types
// -------------------------------------------------------

export type LocalInitializeOptions = {
  /** Absolute path to the .db file. Must not already exist. */
  path: string;
  /** IANA timezone string e.g. "America/New_York". */
  timezone: string;
  /** Entity ID of the stack owner. */
  entityId: string;
};

export type LocalOpenOptions = {
  /** Absolute path to an existing .db file. */
  path: string;
};

// -------------------------------------------------------
// LocalAdapter
// -------------------------------------------------------

/**
 * Full StackAdapter backed by SQLite (records) and the local filesystem (blobs).
 * Also exposes token management methods for server implementations.
 */
export class LocalAdapter implements StackAdapter {
  private constructor(
    private readonly record: SQLiteRecordAdapter,
    private readonly blob: StackBlobAdapter,
  ) {}

  /**
   * Initialize a new local stack. Fails if the database already exists —
   * use open() for existing stacks.
   */
  static async initialize(opts: LocalInitializeOptions): Promise<LocalAdapter> {
    const record = await SQLiteRecordAdapter.initialize({
      path: opts.path,
      entityId: opts.entityId,
      timezone: opts.timezone,
    });
    const blob = new DiskBlobAdapter(join(dirname(opts.path), 'attachments'));
    return new LocalAdapter(record, blob);
  }

  /**
   * Open an existing local stack. Fails if the database does not exist —
   * use initialize() for new stacks.
   */
  static async open(opts: LocalOpenOptions): Promise<LocalAdapter> {
    const record = await SQLiteRecordAdapter.open({ path: opts.path });
    const blob = new DiskBlobAdapter(join(dirname(opts.path), 'attachments'));
    return new LocalAdapter(record, blob);
  }

  // -------------------------------------------------------
  // StackRecordAdapter
  // -------------------------------------------------------

  get capabilities(): AdapterCapabilities {
    return this.record.capabilities;
  }

  get ownerEntityId(): string {
    return this.record.ownerEntityId;
  }

  get timezone(): string {
    return this.record.timezone;
  }

  async createRecord(record: StackRecord): Promise<StackRecord> {
    return this.record.createRecord(record);
  }

  async getRecord(id: RecordId): Promise<StackRecord | null> {
    return this.record.getRecord(id);
  }

  async patchContent(id: RecordId, patch: Record<string, unknown | null>): Promise<StackRecord> {
    return this.record.patchContent(id, patch);
  }

  async deleteRecord(id: RecordId, opts?: { hard?: boolean }): Promise<void> {
    return this.record.deleteRecord(id, opts);
  }

  async undeleteRecord(id: RecordId): Promise<StackRecord> {
    return this.record.undeleteRecord(id);
  }

  async queryRecords(query: StackQuery): Promise<QueryResult> {
    return this.record.queryRecords(query);
  }

  async associate(id: RecordId, association: Association): Promise<void> {
    return this.record.associate(id, association);
  }

  async dissociate(id: RecordId, association: Association): Promise<void> {
    return this.record.dissociate(id, association);
  }

  async setPermissions(id: RecordId, permissions: Permission[]): Promise<void> {
    return this.record.setPermissions(id, permissions);
  }

  async getVersions(id: RecordId): Promise<RecordVersion[]> {
    return this.record.getVersions(id);
  }

  async getVersion(id: RecordId, version: number): Promise<RecordVersion | null> {
    return this.record.getVersion(id, version);
  }

  async saveVersion(id: RecordId, version: RecordVersion): Promise<void> {
    return this.record.saveVersion(id, version);
  }

  async restoreVersion(id: RecordId, version: number): Promise<StackRecord> {
    return this.record.restoreVersion(id, version);
  }

  async commitMigration(
    id: RecordId,
    toTypeId: TypeId,
    content: Record<string, unknown>,
  ): Promise<StackRecord> {
    return this.record.commitMigration(id, toTypeId, content);
  }

  async saveType(type: StackType): Promise<void> {
    return this.record.saveType(type);
  }

  async getType(id: TypeId): Promise<StackType | null> {
    return this.record.getType(id);
  }

  async listTypes(): Promise<StackType[]> {
    return this.record.listTypes();
  }

  // -------------------------------------------------------
  // StackBlobAdapter
  // -------------------------------------------------------

  async putAttachment(data: Uint8Array): Promise<FileId> {
    return this.blob.putAttachment(data);
  }

  async getAttachment(fileId: FileId): Promise<Uint8Array> {
    return this.blob.getAttachment(fileId);
  }

  async deleteAttachment(fileId: FileId): Promise<void> {
    return this.blob.deleteAttachment(fileId);
  }

  // -------------------------------------------------------
  // Tokens (SQLite-specific extras for server implementations)
  // -------------------------------------------------------

  async createToken(
    entityId: string,
    opts?: { label?: string; expiresAt?: Date },
  ): Promise<{ id: string; token: string }> {
    return this.record.createToken(entityId, opts);
  }

  async lookupToken(token: string): Promise<{ entityId: string } | null> {
    return this.record.lookupToken(token);
  }

  async listTokens(): Promise<Awaited<ReturnType<SQLiteRecordAdapter['listTokens']>>> {
    return this.record.listTokens();
  }

  async revokeToken(id: string): Promise<void> {
    return this.record.revokeToken(id);
  }

  // -------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------

  async flush(): Promise<void> {
    await this.record.flush?.();
    await this.blob.flush?.();
  }

  async close(): Promise<void> {
    await this.record.close?.();
    await this.blob.close?.();
  }
}

// Also export combineAdapters for users who want to compose their own adapters
export { combineAdapters } from '@haverstack/core';
