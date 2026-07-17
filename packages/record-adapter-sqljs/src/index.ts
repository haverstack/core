/**
 * Haverstack — SQLite Record Adapter (browser)
 * -------------------------------------------------------
 * Implements StackRecordAdapter using sql.js (SQLite compiled
 * to WebAssembly) — an in-memory engine with no filesystem access
 * of its own, which is exactly sql.js's reason to exist: it's for
 * browser contexts (OPFS, IndexedDB, a download) where there is no
 * real filesystem, not for Node (see @haverstack/record-adapter-sqlite
 * for that — page-level writes, WAL, real file locking).
 *
 * Durability is the embedder's concern: initialize()/open() take an
 * optional `persist(bytes: Uint8Array) => Promise<void>` callback,
 * called after every write with the current serialized database. Wire
 * it to OPFS, IndexedDB, or a manual "download" action — or omit it
 * for a purely in-memory, session-scoped database.
 *
 * Stack config (ownerEntityId, timezone) is stored as a singleton
 * _config@1 record with id='_config' in the records table. Uses FTS4,
 * the sql.js WASM build's full-text search — the native adapter uses
 * FTS5 and can transparently migrate a database created here.
 *
 * No bearer-token storage here — that's server-side tooling with no
 * business in a browser adapter. See @haverstack/core's StackTokenStore
 * and @haverstack/record-adapter-sqlite's NativeTokenStore.
 *
 * This class itself is a thin sql.js binding: WASM init and export/
 * persist are genuinely engine-specific and live here. The actual
 * StackRecordAdapter logic lives once in @haverstack/sqlite-shared's
 * SharedSqlRecordLogic, shared with the native record-adapter-sqlite
 * via the SqlExecutor interface (SqlJsExecutor here normalizes sql.js's
 * bind/step/free calls to it).
 */

import initSqlJs from 'sql.js';
import type { Database, BindParams } from 'sql.js';
import type { StackRecordAdapter } from '@haverstack/core';
import {
  RECORD_SCHEMA_SQL,
  FTS4_SCHEMA_SQL,
  PRAGMA_FOREIGN_KEYS_ON,
  sanitizeFts4Query,
  fts4Strategy,
  insertConfigRecord,
  readStackConfig,
  SharedSqlRecordLogic,
  type SqlExecutor,
} from '@haverstack/sqlite-shared';
import type {
  StackRecord,
  StackType,
  TypeId,
  RecordId,
  FileId,
  RecordVersion,
  StackQuery,
  QueryResult,
  Association,
  Permission,
  AdapterCapabilities,
} from '@haverstack/core';

// -------------------------------------------------------
// Types
// -------------------------------------------------------

/** Called after every write with the current serialized database. */
export type PersistFn = (bytes: Uint8Array) => Promise<void>;

export type SQLiteRecordInitializeOptions = {
  /** IANA timezone string e.g. "America/New_York". */
  timezone: string;
  /** Entity ID of the stack owner. */
  entityId: string;
  /** Called after every write. Omit for a purely in-memory, non-persisted database. */
  persist?: PersistFn;
};

export type SQLiteRecordOpenOptions = {
  /** Serialized database bytes previously produced by `persist` (or initialize()'s first snapshot). */
  bytes: Uint8Array;
  /** Called after every write. Omit for a purely in-memory, non-persisted database. */
  persist?: PersistFn;
};

const SCHEMA_SQL = `${RECORD_SCHEMA_SQL}\n${FTS4_SCHEMA_SQL}`;

// -------------------------------------------------------
// SqlExecutor over a sql.js Database
// -------------------------------------------------------

class SqlJsExecutor implements SqlExecutor {
  constructor(private readonly db: Database) {}

  exec(sql: string): void {
    this.db.run(sql);
  }

  run(sql: string, params: readonly unknown[] = []): number {
    this.db.run(sql, params as BindParams);
    return this.db.getRowsModified();
  }

  get<T = Record<string, unknown>>(sql: string, params: readonly unknown[] = []): T | undefined {
    const stmt = this.db.prepare(sql);
    stmt.bind(params as BindParams);
    if (!stmt.step()) {
      stmt.free();
      return undefined;
    }
    const row = stmt.getAsObject() as T;
    stmt.free();
    return row;
  }

  all<T = Record<string, unknown>>(sql: string, params: readonly unknown[] = []): T[] {
    const stmt = this.db.prepare(sql);
    stmt.bind(params as BindParams);
    const results: T[] = [];
    while (stmt.step()) {
      results.push(stmt.getAsObject() as T);
    }
    stmt.free();
    return results;
  }
}

// -------------------------------------------------------
// SQLiteRecordAdapter
// -------------------------------------------------------

export class SQLiteRecordAdapter implements StackRecordAdapter {
  readonly capabilities: AdapterCapabilities = {
    fullTextSearch: true,
    contentFieldQuery: true,
    sortableFields: ['createdAt', 'updatedAt', 'version'],
    maxAttachmentBytes: null,
  };

  ownerEntityId!: string;
  timezone!: string;

  private db!: Database;
  private exec!: SqlExecutor;
  private record!: SharedSqlRecordLogic;
  private onPersist: PersistFn | undefined;

  private constructor() {}

  private wire(): void {
    this.exec = new SqlJsExecutor(this.db);
    this.record = new SharedSqlRecordLogic({
      exec: this.exec,
      fts: fts4Strategy,
      sanitizeSearch: sanitizeFts4Query,
      onWrite: () => this.persist(),
    });
  }

  /** Initialize a fresh, empty stack database, held entirely in memory. */
  static async initialize(opts: SQLiteRecordInitializeOptions): Promise<SQLiteRecordAdapter> {
    const SQL = await initSqlJs();
    const adapter = new SQLiteRecordAdapter();
    adapter.onPersist = opts.persist;
    adapter.db = new SQL.Database();
    adapter.db.run(PRAGMA_FOREIGN_KEYS_ON);
    adapter.db.run(SCHEMA_SQL);
    adapter.wire();
    insertConfigRecord(adapter.exec, opts.entityId, opts.timezone);
    adapter.ownerEntityId = opts.entityId;
    adapter.timezone = opts.timezone;
    await adapter.persist();
    return adapter;
  }

  /** Open a stack database from previously-persisted bytes. */
  static async open(opts: SQLiteRecordOpenOptions): Promise<SQLiteRecordAdapter> {
    const SQL = await initSqlJs();
    const adapter = new SQLiteRecordAdapter();
    adapter.onPersist = opts.persist;
    adapter.db = new SQL.Database(opts.bytes);
    adapter.db.run(PRAGMA_FOREIGN_KEYS_ON);
    adapter.db.run(SCHEMA_SQL);
    adapter.wire();
    const config = readStackConfig(adapter.exec);
    adapter.ownerEntityId = config.entityId;
    adapter.timezone = config.timezone;
    return adapter;
  }

  // -------------------------------------------------------
  // Persistence
  // -------------------------------------------------------

  /** Exports the in-memory database and hands the bytes to the host's persist callback, if any. */
  private async persist(): Promise<void> {
    if (!this.onPersist) return;
    const bytes = this.db.export();
    // sql.js quirk: export() resets connection-level pragmas (including
    // foreign_keys) on the live Database object — reapply immediately so
    // FK enforcement doesn't silently go stale after the first write.
    this.db.run(PRAGMA_FOREIGN_KEYS_ON);
    await this.onPersist(bytes);
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

  async flush(): Promise<void> {
    await this.persist();
  }

  async close(): Promise<void> {
    this.db.close();
  }
}
