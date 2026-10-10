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
 * compose them with combineAdapters() from @haverstack/core/adapter.
 */

import { dirname, join } from 'path';
import type {
  JournalQuery,
  VersionsQuery,
  RecordJournalEntry,
  StackRecord,
  StackType,
  TypeId,
  RecordVersion,
  Actor,
  StackQuery,
  QueryResult,
  AssociationEdit,
  RecordId,
  FileId,
  RecordChangeSet,
  StackCapabilities,
} from '@haverstack/core';
import type {
  StackAdapter,
  BlobInfo,
  StackBlobAdapter,
  BumpVersionOptions,
  JournalOptions,
  MutateOptions,
} from '@haverstack/core/adapter';
import type { TokenSession, TokenInfo } from '@haverstack/core/wire';
import {
  NativeSQLiteRecordAdapter,
  NativeTokenStore,
  defaultTokenStorePath,
  type NativeSQLiteRecordAdapterOpenOptions,
} from '@haverstack/record-adapter-sqlite';
import { DiskBlobAdapter } from '@haverstack/blob-adapter-disk';

export {
  NativeSQLiteRecordAdapter,
  NativeTokenStore,
  defaultTokenStorePath,
} from '@haverstack/record-adapter-sqlite';
export type {
  NativeSQLiteRecordAdapterOpenOptions,
  OwnerEntityIdInput,
  StoreCreateMode,
  NativeTokenStoreOpenOptions,
} from '@haverstack/record-adapter-sqlite';
export type { TokenSession, TokenInfo } from '@haverstack/core/wire';
export { DiskBlobAdapter } from '@haverstack/blob-adapter-disk';
export type { DiskBlobAdapterOptions } from '@haverstack/blob-adapter-disk';

// -------------------------------------------------------
// Option types
// -------------------------------------------------------

/** Same shape as NativeSQLiteRecordAdapter's: LocalAdapter adds only blob storage. */
export type LocalAdapterOpenOptions = NativeSQLiteRecordAdapterOpenOptions;

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
   * Opens or creates the local stack at `opts.path` according to `opts.create`;
   * see NativeSQLiteRecordAdapter.open() for the modes and owner checks.
   */
  static async open(opts: LocalAdapterOpenOptions): Promise<LocalAdapter> {
    const record = await NativeSQLiteRecordAdapter.open(opts);
    const blob = new DiskBlobAdapter({ dir: join(dirname(opts.path), 'attachments') });
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

  get capabilities(): StackCapabilities {
    return this.record.capabilities;
  }

  get ownerEntityId(): string {
    return this.record.ownerEntityId;
  }

  get timezone(): string | undefined {
    return this.record.timezone;
  }

  async createRecord(record: StackRecord, opts?: JournalOptions): Promise<StackRecord> {
    return this.record.createRecord(record, opts);
  }

  async getRecord(id: RecordId): Promise<StackRecord | null> {
    return this.record.getRecord(id);
  }

  async mutateRecord(
    id: RecordId,
    changes: RecordChangeSet,
    opts?: MutateOptions & BumpVersionOptions,
  ): Promise<StackRecord> {
    return this.record.mutateRecord(id, changes, opts);
  }

  async deleteRecord(
    id: RecordId,
    opts?: { purge?: boolean } & MutateOptions,
  ): Promise<StackRecord | null> {
    return this.record.deleteRecord(id, opts);
  }

  async undeleteRecord(id: RecordId, opts?: MutateOptions): Promise<StackRecord> {
    return this.record.undeleteRecord(id, opts);
  }

  async queryRecords(query: StackQuery): Promise<QueryResult> {
    return this.record.queryRecords(query);
  }

  async deleteUnreferencedAttachmentRecords(
    fileId: FileId,
    metadataTypeIds: TypeId[],
  ): Promise<StackRecord[]> {
    return this.record.deleteUnreferencedAttachmentRecords(fileId, metadataTypeIds);
  }

  async amendAssociations(
    id: RecordId,
    changes: AssociationEdit[],
    opts?: JournalOptions,
  ): Promise<StackRecord> {
    return this.record.amendAssociations(id, changes, opts);
  }

  async getJournal(id: RecordId, query?: JournalQuery): Promise<RecordJournalEntry[]> {
    return this.record.getJournal(id, query);
  }

  async getVersions(id: RecordId, query?: VersionsQuery): Promise<RecordVersion[]> {
    return this.record.getVersions(id, query);
  }

  async getVersion(id: RecordId, version: number): Promise<RecordVersion | null> {
    return this.record.getVersion(id, version);
  }

  async saveVersion(id: RecordId, version: RecordVersion): Promise<void> {
    return this.record.saveVersion(id, version);
  }

  async restoreVersion(id: RecordId, version: number, opts?: MutateOptions): Promise<StackRecord> {
    return this.record.restoreVersion(id, version, opts);
  }

  async commitMigration(
    id: RecordId,
    toTypeId: TypeId,
    content: Record<string, unknown>,
    opts?: MutateOptions,
  ): Promise<StackRecord> {
    return this.record.commitMigration(id, toTypeId, content, opts);
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

  async putBlob(data: Uint8Array): Promise<FileId> {
    return this.blob.putBlob(data);
  }

  async getBlob(fileId: FileId): Promise<Uint8Array> {
    return this.blob.getBlob(fileId);
  }

  async deleteBlob(fileId: FileId): Promise<void> {
    return this.blob.deleteBlob(fileId);
  }

  /** DiskBlobAdapter always implements this — LocalAdapter always constructs one. */
  async listBlobs(): Promise<BlobInfo[]> {
    return this.blob.listBlobs!();
  }

  // -------------------------------------------------------
  // Tokens (server-implementation convenience, backed by a separate file)
  // -------------------------------------------------------

  async createToken(
    actor: Actor,
    opts?: { label?: string; expiresAt?: Date },
  ): Promise<{ id: string; token: string }> {
    const store = await this.getTokenStore();
    return store.createToken(actor, opts);
  }

  async lookupToken(token: string): Promise<TokenSession | null> {
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

export { combineAdapters } from '@haverstack/core/adapter';
