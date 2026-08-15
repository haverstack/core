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
import { existsSync } from 'fs';
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
  RecordId,
  FileId,
  TokenSession,
} from '@haverstack/core';
import type { AdapterCapabilities, BlobFileInfo, StackBlobAdapter } from '@haverstack/core/adapter';
import type { TokenInfo } from '@haverstack/core/wire';
import {
  NativeSQLiteRecordAdapter,
  NativeTokenStore,
  defaultTokenStorePath,
} from '@haverstack/record-adapter-sqlite';
import { DiskBlobAdapter } from '@haverstack/blob-adapter-disk';

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
export type { TokenSession } from '@haverstack/core';
export type { TokenInfo } from '@haverstack/core/wire';
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

export type LocalOpenOrInitializeOptions = {
  /** Absolute path to the .db file — opened if it exists, initialized if not. */
  path: string;
  /**
   * Entity ID of the stack owner, consulted only on the initialize path
   * (the file doesn't exist yet). Pass a plain DID string, or a lazy
   * `() => string | Promise<string>` (e.g. wrapping `generateDidKeypair()`)
   * so keypair generation only happens when a stack is actually being
   * created — the provider is never invoked when the file already exists.
   *
   * A plain string is also asserted against the existing stack's owner on
   * the open path, to catch silent config divergence. A lazy provider is
   * *not* checked there — invoking it just to compare would defeat the
   * point of making it lazy.
   */
  entityId: string | (() => string | Promise<string>);
  /** IANA timezone string. Consulted only on the initialize path. */
  timezone?: string;
  /** Bypass the storage-ownership lock check. See LocalOpenOptions.force. */
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

  /**
   * Open the stack at `path` if it already exists, or initialize a new one
   * there if it doesn't — the first-run choreography (does the db exist?
   * open : generate identity, initialize) that every adopter otherwise
   * has to write by hand. See LocalOpenOrInitializeOptions for how
   * `entityId` is used differently on each path.
   */
  static async openOrInitialize(opts: LocalOpenOrInitializeOptions): Promise<LocalAdapter> {
    if (existsSync(opts.path)) {
      const adapter = await LocalAdapter.open({ path: opts.path, force: opts.force });
      if (typeof opts.entityId === 'string' && opts.entityId !== adapter.ownerEntityId) {
        throw new Error(
          `Cannot open: stack at "${opts.path}" is owned by "${adapter.ownerEntityId}", ` +
            `but openOrInitialize() was called with entityId "${opts.entityId}".`,
        );
      }
      return adapter;
    }

    const entityId = typeof opts.entityId === 'function' ? await opts.entityId() : opts.entityId;
    return LocalAdapter.initialize({
      path: opts.path,
      entityId,
      timezone: opts.timezone,
      force: opts.force,
    });
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
    opts?: { expectedVersion?: number; snapshot?: RecordVersion },
  ): Promise<StackRecord> {
    return this.record.patchContent(id, patch, opts);
  }

  async deleteRecord(
    id: RecordId,
    opts?: { hard?: boolean; expectedVersion?: number; snapshot?: RecordVersion },
  ): Promise<void> {
    return this.record.deleteRecord(id, opts);
  }

  async undeleteRecord(
    id: RecordId,
    opts?: { expectedVersion?: number; snapshot?: RecordVersion },
  ): Promise<StackRecord> {
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
    opts?: { expectedVersion?: number; snapshot?: RecordVersion },
  ): Promise<void> {
    return this.record.associate(id, association, opts);
  }

  async dissociate(
    id: RecordId,
    association: Association,
    opts?: { expectedVersion?: number; snapshot?: RecordVersion },
  ): Promise<void> {
    return this.record.dissociate(id, association, opts);
  }

  async setPermissions(
    id: RecordId,
    permissions: Permission[],
    opts?: { expectedVersion?: number; snapshot?: RecordVersion },
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
    opts?: { expectedVersion?: number; snapshot?: RecordVersion },
  ): Promise<StackRecord> {
    return this.record.restoreVersion(id, version, opts);
  }

  async commitMigration(
    id: RecordId,
    toTypeId: TypeId,
    content: Record<string, unknown>,
    opts?: { snapshot?: RecordVersion },
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

  async putAttachment(data: Uint8Array): Promise<FileId> {
    return this.blob.putAttachment(data);
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
    principalId: string,
    opts?: { onBehalfOf?: string; label?: string; expiresAt?: Date },
  ): Promise<{ id: string; token: string }> {
    const store = await this.getTokenStore();
    return store.createToken(principalId, opts);
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

// Also export combineAdapters for users who want to compose their own adapters
export { combineAdapters } from '@haverstack/core/adapter';
