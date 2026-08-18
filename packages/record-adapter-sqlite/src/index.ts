/**
 * Haverstack — Native SQLite Record Adapter
 * -------------------------------------------------------
 * Implements StackRecordAdapter using node:sqlite (Node's built-in
 * SQLite binding, Node >= 22.5). No native compilation, no node-gyp,
 * no prebuilt binaries, and writes go straight to the file via normal
 * SQLite journaling (WAL mode) — no whole-database rewrite per write,
 * no in-memory copy of the whole store, real OS-level file locking.
 * Full-text search uses FTS5.
 *
 * A stack file is owned by exactly one process at a time (see
 * docs/spec/adapters.md § Concurrency & storage ownership). open()/initialize()
 * acquire a PID-stamped lock file beside the database and reject if
 * another live process already holds it; close() releases it.
 *
 * Token storage is a separate concern — see NativeTokenStore in this
 * package, which implements @haverstack/core's StackTokenStore against
 * its own file rather than this adapter's records database.
 *
 * This class itself is a thin node:sqlite binding: schema setup,
 * pragmas, and the storage-ownership lock are genuinely engine-specific
 * and live here. The actual StackRecordAdapter logic lives in
 * @haverstack/sqlite-shared's SharedSqlRecordLogic, reached through the
 * SqlExecutor interface (NativeSqliteExecutor here normalizes
 * node:sqlite's spread-args run/get/all calls to it).
 */

import { DatabaseSync } from './node-sqlite.js';
import { existsSync } from 'fs';
import type { StackType, TypeId, RecordId, FileId, RecordVersion } from '@haverstack/core';
import type {
  StackRecord,
  StackQuery,
  QueryResult,
  Association,
  Permission,
} from '@haverstack/core';
import type { StackRecordAdapter, AdapterCapabilities } from '@haverstack/core/adapter';
import {
  RECORD_SCHEMA_SQL,
  FTS5_SCHEMA_SQL,
  PRAGMA_FOREIGN_KEYS_ON,
  PRAGMA_JOURNAL_MODE_WAL,
  acquireLock,
  releaseLock,
  insertConfigRecord,
  readStackConfig,
  SharedSqlRecordLogic,
} from '@haverstack/sqlite-shared';
import { NativeSqliteExecutor } from './executor.js';

// -------------------------------------------------------
// Types
// -------------------------------------------------------

export type NativeRecordInitializeOptions = {
  /** Absolute path to the .db file. Must not already exist. */
  path: string;
  /** IANA timezone string e.g. "America/New_York". Optional passthrough app metadata — no default. */
  timezone?: string;
  /** Entity ID of the stack owner. */
  entityId: string;
  /** Bypass the storage-ownership lock check. See NativeRecordOpenOptions.force. */
  force?: boolean;
};

export type NativeRecordOpenOptions = {
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
// NativeSQLiteRecordAdapter
// -------------------------------------------------------

export class NativeSQLiteRecordAdapter implements StackRecordAdapter {
  readonly capabilities: AdapterCapabilities = {
    fullTextSearch: true,
    contentFieldQuery: true,
    sortableFields: ['createdAt', 'updatedAt', 'version'],
    maxAttachmentBytes: null,
    maxContentBytes: null,
  };

  ownerEntityId!: string;
  timezone: string | undefined;

  private db!: DatabaseSync;
  private record!: SharedSqlRecordLogic;

  private constructor(private readonly path: string) {}

  private wire(): void {
    const exec = new NativeSqliteExecutor(this.db);
    this.record = new SharedSqlRecordLogic({ exec });
  }

  /**
   * Initialize a new stack database. Fails if the file already exists —
   * use open() for existing databases.
   */
  static async initialize(opts: NativeRecordInitializeOptions): Promise<NativeSQLiteRecordAdapter> {
    if (existsSync(opts.path)) {
      throw new Error(
        `Cannot initialize: database already exists at "${opts.path}". ` +
          `Use NativeSQLiteRecordAdapter.open() instead.`,
      );
    }
    acquireLock(opts.path, opts.force);
    const adapter = new NativeSQLiteRecordAdapter(opts.path);
    adapter.db = new DatabaseSync(opts.path);
    adapter.db.exec(PRAGMA_FOREIGN_KEYS_ON);
    adapter.db.exec(PRAGMA_JOURNAL_MODE_WAL);
    adapter.db.exec(RECORD_SCHEMA_SQL);
    adapter.db.exec(FTS5_SCHEMA_SQL);
    adapter.wire();
    insertConfigRecord(new NativeSqliteExecutor(adapter.db), opts.entityId, opts.timezone);
    adapter.ownerEntityId = opts.entityId;
    adapter.timezone = opts.timezone;
    return adapter;
  }

  /**
   * Open an existing stack database. Fails if the file does not exist —
   * use initialize() for new databases.
   */
  static async open(opts: NativeRecordOpenOptions): Promise<NativeSQLiteRecordAdapter> {
    if (!existsSync(opts.path)) {
      throw new Error(
        `Cannot open: no database found at "${opts.path}". ` +
          `Use NativeSQLiteRecordAdapter.initialize() to create one.`,
      );
    }
    acquireLock(opts.path, opts.force);
    const adapter = new NativeSQLiteRecordAdapter(opts.path);
    adapter.db = new DatabaseSync(opts.path);
    adapter.db.exec(PRAGMA_FOREIGN_KEYS_ON);
    adapter.db.exec(PRAGMA_JOURNAL_MODE_WAL);
    adapter.db.exec(RECORD_SCHEMA_SQL);
    adapter.db.exec(FTS5_SCHEMA_SQL);
    adapter.wire();
    const config = readStackConfig(new NativeSqliteExecutor(adapter.db));
    adapter.ownerEntityId = config.entityId;
    adapter.timezone = config.timezone;
    return adapter;
  }

  // -------------------------------------------------------
  // Records
  // -------------------------------------------------------

  createRecord(record: StackRecord): Promise<StackRecord> {
    return this.record.createRecord(record);
  }

  getRecord(id: string): Promise<StackRecord | null> {
    return this.record.getRecord(id);
  }

  patchContent(
    id: string,
    patch: Record<string, unknown | null>,
    opts?: { expectedVersion?: number; snapshot?: RecordVersion },
  ): Promise<StackRecord> {
    return this.record.patchContent(id, patch, opts);
  }

  deleteRecord(
    id: string,
    opts?: { hard?: boolean; expectedVersion?: number; snapshot?: RecordVersion },
  ): Promise<void> {
    return this.record.deleteRecord(id, opts);
  }

  undeleteRecord(
    id: string,
    opts?: { expectedVersion?: number; snapshot?: RecordVersion },
  ): Promise<StackRecord> {
    return this.record.undeleteRecord(id, opts);
  }

  setPermissions(
    id: string,
    permissions: Permission[],
    opts?: { expectedVersion?: number; snapshot?: RecordVersion },
  ): Promise<void> {
    return this.record.setPermissions(id, permissions, opts);
  }

  restoreVersion(
    id: string,
    version: number,
    opts?: { expectedVersion?: number; snapshot?: RecordVersion },
  ): Promise<StackRecord> {
    return this.record.restoreVersion(id, version, opts);
  }

  commitMigration(
    id: string,
    toTypeId: TypeId,
    content: Record<string, unknown>,
    opts?: { expectedVersion?: number; snapshot?: RecordVersion },
  ): Promise<StackRecord> {
    return this.record.commitMigration(id, toTypeId, content, opts);
  }

  queryRecords(query: StackQuery): Promise<QueryResult> {
    return this.record.queryRecords(query);
  }

  deleteUnreferencedAttachmentRecords(fileId: FileId, metadataTypeId: TypeId): Promise<RecordId[]> {
    return this.record.deleteUnreferencedAttachmentRecords(fileId, metadataTypeId);
  }

  // -------------------------------------------------------
  // Versions
  // -------------------------------------------------------

  getVersions(id: string): Promise<RecordVersion[]> {
    return this.record.getVersions(id);
  }

  getVersion(id: string, version: number): Promise<RecordVersion | null> {
    return this.record.getVersion(id, version);
  }

  saveVersion(id: string, version: RecordVersion): Promise<void> {
    return this.record.saveVersion(id, version);
  }

  // -------------------------------------------------------
  // Types
  // -------------------------------------------------------

  saveType(type: StackType): Promise<void> {
    return this.record.saveType(type);
  }

  getType(id: TypeId): Promise<StackType | null> {
    return this.record.getType(id);
  }

  listTypes(): Promise<StackType[]> {
    return this.record.listTypes();
  }

  // -------------------------------------------------------
  // Associations
  // -------------------------------------------------------

  associate(
    recordId: string,
    association: Association,
    opts?: { expectedVersion?: number; snapshot?: RecordVersion },
  ): Promise<void> {
    return this.record.associate(recordId, association, opts);
  }

  dissociate(
    recordId: string,
    association: Association,
    opts?: { expectedVersion?: number; snapshot?: RecordVersion },
  ): Promise<void> {
    return this.record.dissociate(recordId, association, opts);
  }

  // -------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------

  /** Folds the WAL back into the main file — useful before copying/backing up the database. */
  async flush(): Promise<void> {
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
  }

  async close(): Promise<void> {
    this.db.close();
    releaseLock(this.path);
  }
}

export {
  NativeTokenStore,
  defaultTokenStorePath,
  type NativeTokenStoreOptions,
} from './token-store.js';
