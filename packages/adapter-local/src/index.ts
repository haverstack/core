/**
 * Haverstack — Local Adapter
 * -------------------------------------------------------
 * Convenience StackAdapter that combines NativeSQLiteRecordAdapter
 * (records, types, versions, associations) with DiskBlobAdapter
 * (binary attachments stored next to the DB). Bearer-token methods
 * are exposed too, as a convenience for server implementations, but
 * backed by a separate NativeTokenStore — see below.
 *
 * For most local use cases this is the only package you need.
 * If you want a different blob backend (e.g. S3), import
 * NativeSQLiteRecordAdapter and DiskBlobAdapter separately and
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
  BlobFileInfo,
  TokenInfo,
} from '@haverstack/core';
import {
  NativeSQLiteRecordAdapter,
  NativeTokenStore,
  defaultTokenStorePath,
} from '@haverstack/record-adapter-sqlite';
import { DiskBlobAdapter } from '@haverstack/blob-adapter-disk';
import type { StackBlobAdapter } from '@haverstack/core';

export {
  NativeSQLiteRecordAdapter,
  NativeTokenStore,
  defaultTokenStorePath,
} from '@haverstack/record-adapter-sqlite';
export type {
  NativeRecordInitializeOptions,
  NativeRecordOpenOptions,
  NativeTokenStoreOptions,
} from '@haverstack/record-adapter-sqlite';
export type { TokenInfo } from '@haverstack/core';
export { DiskBlobAdapter } from '@haverstack/blob-adapter-disk';

// -------------------------------------------------------
// Option types
// -------------------------------------------------------

export type LocalInitializeOptions = {
  /** Absolute path to the .db file. Must not already exist. */
  path: string;
  /** IANA timezone string e.g. "America/New_York". Optional passthrough app metadata — no default. */
  timezone?: string;
  /** Entity ID of the stack owner. */
  entityId: string;
  /** Bypass the storage-ownership lock check. See LocalOpenOptions.force. */
  force?: boolean;
};

export type LocalOpenOptions = {
  /** Absolute path to an existing .db file. */
  path: string;
  /**
   * Open even if a lock file from another live process is present.
   * Only needed if that process is gone but its PID was reused by
   * something else (the automatic stale-lock check already reclaims
   * locks whose owning process is no longer running).
   */
  force?: boolean;
};

// -------------------------------------------------------
// LocalAdapter
// -------------------------------------------------------

/**
 * Full StackAdapter backed by native SQLite (records) and the local
 * filesystem (blobs). Also exposes token management methods for server
 * implementations, backed by a NativeTokenStore in a separate sibling
 * file (`<path>.tokens`) — opened lazily on first use, so plain
 * single-app embedded use that never touches tokens never creates it.
 */
export class LocalAdapter implements StackAdapter {
  private tokenStore?: NativeTokenStore;

  private constructor(
    private readonly record: NativeSQLiteRecordAdapter,
    private readonly blob: StackBlobAdapter,
    private readonly dbPath: string,
    private readonly force: boolean | undefined,
  ) {}

  /**
   * Initialize a new local stack. Fails if the database already exists —
   * use open() for existing stacks.
   */
  static async initialize(opts: LocalInitializeOptions): Promise<LocalAdapter> {
    const record = await NativeSQLiteRecordAdapter.initialize({
      path: opts.path,
      entityId: opts.entityId,
      timezone: opts.timezone,
      force: opts.force,
    });
    const blob = new DiskBlobAdapter(join(dirname(opts.path), 'attachments'));
    return new LocalAdapter(record, blob, opts.path, opts.force);
  }

  /**
   * Open an existing local stack. Fails if the database does not exist —
   * use initialize() for new stacks.
   */
  static async open(opts: LocalOpenOptions): Promise<LocalAdapter> {
    const record = await NativeSQLiteRecordAdapter.open({ path: opts.path, force: opts.force });
    const blob = new DiskBlobAdapter(join(dirname(opts.path), 'attachments'));
    return new LocalAdapter(record, blob, opts.path, opts.force);
  }

  private async getTokenStore(): Promise<NativeTokenStore> {
    if (!this.tokenStore) {
      this.tokenStore = await NativeTokenStore.open({
        path: defaultTokenStorePath(this.dbPath),
        force: this.force,
      });
    }
    return this.tokenStore;
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

  get timezone(): string | undefined {
    return this.record.timezone;
  }

  async createRecord(record: StackRecord): Promise<StackRecord> {
    return this.record.createRecord(record);
  }

  async getRecord(id: RecordId): Promise<StackRecord | null> {
    return this.record.getRecord(id);
  }

  async patchContent(
    id: RecordId,
    patch: Record<string, unknown | null>,
    opts?: { expectedVersion?: number },
  ): Promise<StackRecord> {
    return this.record.patchContent(id, patch, opts);
  }

  async deleteRecord(
    id: RecordId,
    opts?: { hard?: boolean; expectedVersion?: number },
  ): Promise<void> {
    return this.record.deleteRecord(id, opts);
  }

  async undeleteRecord(id: RecordId, opts?: { expectedVersion?: number }): Promise<StackRecord> {
    return this.record.undeleteRecord(id, opts);
  }

  async queryRecords(query: StackQuery): Promise<QueryResult> {
    return this.record.queryRecords(query);
  }

  async deleteUnreferencedAttachmentRecords(
    fileId: FileId,
    metadataTypeId: TypeId,
  ): Promise<RecordId[]> {
    return this.record.deleteUnreferencedAttachmentRecords(fileId, metadataTypeId);
  }

  async associate(
    id: RecordId,
    association: Association,
    opts?: { expectedVersion?: number },
  ): Promise<void> {
    return this.record.associate(id, association, opts);
  }

  async dissociate(
    id: RecordId,
    association: Association,
    opts?: { expectedVersion?: number },
  ): Promise<void> {
    return this.record.dissociate(id, association, opts);
  }

  async setPermissions(
    id: RecordId,
    permissions: Permission[],
    opts?: { expectedVersion?: number },
  ): Promise<void> {
    return this.record.setPermissions(id, permissions, opts);
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

  async restoreVersion(
    id: RecordId,
    version: number,
    opts?: { expectedVersion?: number },
  ): Promise<StackRecord> {
    return this.record.restoreVersion(id, version, opts);
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

  async tryPutAttachmentWithMetadata(
    data: Uint8Array,
    mimeType: string,
    filename?: string,
  ): Promise<{ fileId: FileId; record?: StackRecord }> {
    return this.blob.tryPutAttachmentWithMetadata(data, mimeType, filename);
  }

  async getAttachment(fileId: FileId): Promise<Uint8Array> {
    return this.blob.getAttachment(fileId);
  }

  async deleteAttachment(fileId: FileId): Promise<void> {
    return this.blob.deleteAttachment(fileId);
  }

  /** DiskBlobAdapter always implements this — LocalAdapter always constructs one. */
  async listFiles(): Promise<BlobFileInfo[]> {
    return this.blob.listFiles!();
  }

  // -------------------------------------------------------
  // Tokens (server-implementation convenience, backed by a separate file)
  // -------------------------------------------------------

  async createToken(
    entityId: string,
    opts?: { label?: string; expiresAt?: Date },
  ): Promise<{ id: string; token: string }> {
    const store = await this.getTokenStore();
    return store.createToken(entityId, opts);
  }

  async lookupToken(token: string): Promise<{ entityId: string } | null> {
    const store = await this.getTokenStore();
    return store.lookupToken(token);
  }

  async listTokens(): Promise<TokenInfo[]> {
    const store = await this.getTokenStore();
    return store.listTokens();
  }

  async revokeToken(id: string): Promise<void> {
    const store = await this.getTokenStore();
    return store.revokeToken(id);
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
    await this.tokenStore?.close();
  }
}

// Also export combineAdapters for users who want to compose their own adapters
export { combineAdapters } from '@haverstack/core';
