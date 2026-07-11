/**
 * Haverstack — SQLite Record Adapter
 * -------------------------------------------------------
 * Implements StackRecordAdapter using sql.js (SQLite compiled
 * to WebAssembly). Runs in Node, browsers, and other runtimes
 * without native compilation.
 *
 * The database is held in memory and flushed to disk on every
 * write, atomically (temp file + rename). Stack config
 * (ownerEntityId, timezone) is stored as a singleton _config@1
 * record with id='_config' in the records table.
 *
 * A stack file is owned by exactly one process at a time (see
 * docs/spec.md § Concurrency & storage ownership). open()/
 * initialize() acquire a PID-stamped lock file beside the
 * database and reject if another live process already holds
 * it; close() releases it.
 *
 * Also exposes token management methods (createToken,
 * lookupToken, listTokens, revokeToken) used by server
 * implementations to issue and validate bearer tokens.
 *
 * This class itself is a thin sql.js binding: schema DDL, the
 * storage-ownership lock, and — most of the actual
 * StackRecordAdapter/StackTokenStore logic — live in
 * @haverstack/sqlite-shared's SharedSqlRecordLogic/SharedTokenLogic,
 * shared with the native record-adapter-sqlite via the SqlExecutor
 * interface (SqlJsExecutor here normalizes sql.js's bind/step/free
 * calls to it). What's left here is genuinely sql.js-specific:
 * WASM init, in-memory export/persist, and the pragma-reset quirk.
 */

import initSqlJs from 'sql.js';
import type { Database, SqlJsStatic, BindParams } from 'sql.js';
import { readFileSync, writeFileSync, existsSync, renameSync } from 'fs';
import { dirname, basename, join } from 'path';
import { randomBytes } from 'node:crypto';
import type { StackRecordAdapter, StackTokenStore, TokenInfo } from '@haverstack/core';
export type { TokenInfo } from '@haverstack/core';
import {
  RECORD_SCHEMA_SQL,
  TOKENS_SCHEMA_SQL,
  FTS4_SCHEMA_SQL,
  PRAGMA_FOREIGN_KEYS_ON,
  sanitizeFts4Query,
  fts4Strategy,
  acquireLock,
  releaseLock,
  insertConfigRecord,
  readStackConfig,
  SharedSqlRecordLogic,
  SharedTokenLogic,
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

export type SQLiteRecordInitializeOptions = {
  /** Absolute path to the .db file. Must not already exist. */
  path: string;
  /** IANA timezone string e.g. "America/New_York". */
  timezone: string;
  /** Entity ID of the stack owner. */
  entityId: string;
  /** Bypass the storage-ownership lock check. See SQLiteRecordOpenOptions.force. */
  force?: boolean;
};

export type SQLiteRecordOpenOptions = {
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

const SCHEMA_SQL = `${RECORD_SCHEMA_SQL}\n${TOKENS_SCHEMA_SQL}\n${FTS4_SCHEMA_SQL}`;

// -------------------------------------------------------
// SqlExecutor over a sql.js Database
// -------------------------------------------------------

class SqlJsExecutor implements SqlExecutor {
  constructor(private readonly db: Database) {}

  exec(sql: string): void {
    this.db.run(sql);
  }

  run(sql: string, params: readonly unknown[] = []): void {
    this.db.run(sql, params as BindParams);
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

export class SQLiteRecordAdapter implements StackRecordAdapter, StackTokenStore {
  readonly capabilities: AdapterCapabilities = {
    fullTextSearch: true,
    contentFieldQuery: true,
    sortableFields: ['createdAt', 'updatedAt', 'version'],
  };

  ownerEntityId!: string;
  timezone!: string;

  private db!: Database;
  private exec!: SqlExecutor;
  private record!: SharedSqlRecordLogic;
  private tokens!: SharedTokenLogic;

  private constructor(
    private readonly SQL: SqlJsStatic,
    private readonly path: string,
  ) {}

  private wire(): void {
    this.exec = new SqlJsExecutor(this.db);
    this.record = new SharedSqlRecordLogic({
      exec: this.exec,
      fts: fts4Strategy,
      sanitizeSearch: sanitizeFts4Query,
      onWrite: () => this.persist(),
    });
    this.tokens = new SharedTokenLogic({ exec: this.exec, onWrite: () => this.persist() });
  }

  /**
   * Initialize a new stack database. Fails if the file already exists —
   * use open() for existing databases.
   */
  static async initialize(opts: SQLiteRecordInitializeOptions): Promise<SQLiteRecordAdapter> {
    if (existsSync(opts.path)) {
      throw new Error(
        `Cannot initialize: database already exists at "${opts.path}". ` +
          `Use SQLiteRecordAdapter.open() instead.`,
      );
    }
    acquireLock(opts.path, opts.force);
    const SQL = await initSqlJs();
    const adapter = new SQLiteRecordAdapter(SQL, opts.path);
    adapter.db = new SQL.Database();
    adapter.db.run(PRAGMA_FOREIGN_KEYS_ON);
    adapter.db.run(SCHEMA_SQL);
    adapter.wire();
    insertConfigRecord(adapter.exec, opts.entityId, opts.timezone);
    adapter.ownerEntityId = opts.entityId;
    adapter.timezone = opts.timezone;
    adapter.persist();
    return adapter;
  }

  /**
   * Open an existing stack database. Fails if the file does not exist —
   * use initialize() for new databases.
   */
  static async open(opts: SQLiteRecordOpenOptions): Promise<SQLiteRecordAdapter> {
    if (!existsSync(opts.path)) {
      throw new Error(
        `Cannot open: no database found at "${opts.path}". ` +
          `Use SQLiteRecordAdapter.initialize() to create one.`,
      );
    }
    acquireLock(opts.path, opts.force);
    const SQL = await initSqlJs();
    const adapter = new SQLiteRecordAdapter(SQL, opts.path);
    const fileBuffer = readFileSync(opts.path);
    adapter.db = new SQL.Database(fileBuffer);
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

  /**
   * Flush the in-memory database to disk. Called after every write.
   * Writes to a temp file in the same directory and renames it over
   * the target — rename is atomic on POSIX, so a crash mid-write can
   * never leave a torn, unreadable database file.
   */
  private persist(): void {
    const data = this.db.export();
    // sql.js quirk: export() resets connection-level pragmas (including
    // foreign_keys) on the live Database object — reapply immediately so
    // FK enforcement doesn't silently go stale after the first write.
    this.db.run(PRAGMA_FOREIGN_KEYS_ON);
    const tmpPath = join(
      dirname(this.path),
      `.${basename(this.path)}.tmp-${randomBytes(6).toString('hex')}`,
    );
    writeFileSync(tmpPath, Buffer.from(data));
    renameSync(tmpPath, this.path);
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

  patchContent(id: string, patch: Record<string, unknown | null>): Promise<StackRecord> {
    return this.record.patchContent(id, patch);
  }

  deleteRecord(id: string, opts?: { hard?: boolean }): Promise<void> {
    return this.record.deleteRecord(id, opts);
  }

  undeleteRecord(id: string): Promise<StackRecord> {
    return this.record.undeleteRecord(id);
  }

  setPermissions(id: string, permissions: Permission[]): Promise<void> {
    return this.record.setPermissions(id, permissions);
  }

  restoreVersion(id: string, version: number): Promise<StackRecord> {
    return this.record.restoreVersion(id, version);
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

  associate(recordId: string, association: Association): Promise<void> {
    return this.record.associate(recordId, association);
  }

  dissociate(recordId: string, association: Association): Promise<void> {
    return this.record.dissociate(recordId, association);
  }

  // -------------------------------------------------------
  // Tokens
  // -------------------------------------------------------

  createToken(
    entityId: string,
    opts?: { label?: string; expiresAt?: Date },
  ): Promise<{ id: string; token: string }> {
    return this.tokens.createToken(entityId, opts);
  }

  lookupToken(token: string): Promise<{ entityId: string } | null> {
    return this.tokens.lookupToken(token);
  }

  listTokens(): Promise<TokenInfo[]> {
    return this.tokens.listTokens();
  }

  revokeToken(id: string): Promise<void> {
    return this.tokens.revokeToken(id);
  }

  // -------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------

  async flush(): Promise<void> {
    this.persist();
  }

  async close(): Promise<void> {
    this.db.close();
    releaseLock(this.path);
  }
}
