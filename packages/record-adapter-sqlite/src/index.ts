/**
 * Haverstack — Native SQLite Record Adapter
 * -------------------------------------------------------
 * Implements StackRecordAdapter using node:sqlite (Node's built-in
 * SQLite binding, Node >= 22.5). No native compilation, no node-gyp,
 * no prebuilt binaries — same "just works" property that motivated
 * sql.js, without sql.js's costs on the Node path: writes go straight
 * to the file via normal SQLite journaling (WAL mode), so there's no
 * whole-database export/rewrite on every write, no in-memory copy of
 * the whole store, and real OS-level file locking.
 *
 * Uses FTS5 for full-text search. A database created by
 * record-adapter-sqljs (FTS4) opens here transparently — open()
 * detects an FTS4 records_fts table and rebuilds it as FTS5 once,
 * automatically.
 *
 * A stack file is owned by exactly one process at a time (see
 * docs/spec.md § Concurrency & storage ownership). open()/initialize()
 * acquire a PID-stamped lock file beside the database and reject if
 * another live process already holds it; close() releases it.
 *
 * Token storage is a separate concern — see NativeTokenStore in this
 * package, which implements @haverstack/core's StackTokenStore against
 * its own file rather than this adapter's records database.
 *
 * This class itself is a thin node:sqlite binding: schema setup,
 * pragmas, the storage-ownership lock, and the FTS4->FTS5 migration are
 * genuinely engine-specific and live here. The actual
 * StackRecordAdapter logic lives once in @haverstack/sqlite-shared's
 * SharedSqlRecordLogic, shared with record-adapter-sqljs via the
 * SqlExecutor interface (NativeSqliteExecutor here normalizes
 * node:sqlite's spread-args run/get/all calls to it).
 */

import { DatabaseSync } from './node-sqlite.js';
import { existsSync } from 'fs';
import type {
  StackRecordAdapter,
  StackType,
  TypeId,
  RecordId,
  FileId,
  RecordVersion,
} from '@haverstack/core';
import type {
  StackRecord,
  StackQuery,
  QueryResult,
  Association,
  Permission,
  AdapterCapabilities,
} from '@haverstack/core';
import {
  RECORD_SCHEMA_SQL,
  FTS5_SCHEMA_SQL,
  PRAGMA_FOREIGN_KEYS_ON,
  PRAGMA_JOURNAL_MODE_WAL,
  sanitizeFts5Query,
  fts5Strategy,
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
  /** IANA timezone string e.g. "America/New_York". */
  timezone: string;
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
// FTS4 -> FTS5 migration
// -------------------------------------------------------

/**
 * A database created by record-adapter-sqljs has an FTS4 records_fts
 * table. Detect it via sqlite_master (which stores the verbatim CREATE
 * statement for virtual tables) and rebuild as FTS5 — one-time, cheap,
 * transparent. No-op if the table is already FTS5 (or absent, in which
 * case FTS5_SCHEMA_SQL's IF NOT EXISTS creates it fresh).
 */
const migrateFtsIfNeeded = (db: DatabaseSync): void => {
  const existing = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'records_fts'`)
    .get() as { sql: string } | undefined;

  if (existing && /\busing\s+fts4\b/i.test(existing.sql)) {
    db.exec('DROP TABLE records_fts');
    db.exec(FTS5_SCHEMA_SQL);
    db.exec(`INSERT INTO records_fts(rowid, content) SELECT rowid, content FROM records`);
    return;
  }
  db.exec(FTS5_SCHEMA_SQL);
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
  };

  ownerEntityId!: string;
  timezone!: string;

  private db!: DatabaseSync;
  private record!: SharedSqlRecordLogic;

  private constructor(private readonly path: string) {}

  private wire(): void {
    const exec = new NativeSqliteExecutor(this.db);
    this.record = new SharedSqlRecordLogic({
      exec,
      fts: fts5Strategy,
      sanitizeSearch: sanitizeFts5Query,
    });
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
   * use initialize() for new databases. Transparently migrates an FTS4
   * records_fts table (from record-adapter-sqljs) to FTS5.
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
    migrateFtsIfNeeded(adapter.db);
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
    opts?: { expectedVersion?: number },
  ): Promise<StackRecord> {
    return this.record.patchContent(id, patch, opts);
  }

  deleteRecord(id: string, opts?: { hard?: boolean; expectedVersion?: number }): Promise<void> {
    return this.record.deleteRecord(id, opts);
  }

  undeleteRecord(id: string, opts?: { expectedVersion?: number }): Promise<StackRecord> {
    return this.record.undeleteRecord(id, opts);
  }

  setPermissions(
    id: string,
    permissions: Permission[],
    opts?: { expectedVersion?: number },
  ): Promise<void> {
    return this.record.setPermissions(id, permissions, opts);
  }

  restoreVersion(
    id: string,
    version: number,
    opts?: { expectedVersion?: number },
  ): Promise<StackRecord> {
    return this.record.restoreVersion(id, version, opts);
  }

  commitMigration(
    id: string,
    toTypeId: TypeId,
    content: Record<string, unknown>,
  ): Promise<StackRecord> {
    return this.record.commitMigration(id, toTypeId, content);
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
    opts?: { expectedVersion?: number },
  ): Promise<void> {
    return this.record.associate(recordId, association, opts);
  }

  dissociate(
    recordId: string,
    association: Association,
    opts?: { expectedVersion?: number },
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
