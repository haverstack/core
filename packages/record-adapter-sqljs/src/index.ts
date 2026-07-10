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
 * Schema DDL, WHERE/ORDER building, cursor codec, row mappers,
 * and the FTS4 sanitizer live in @haverstack/sqlite-shared —
 * shared with the native record-adapter-sqlite so the two
 * engines can't drift on engine-independent SQL.
 */

import initSqlJs from 'sql.js';
import type { Database, SqlJsStatic } from 'sql.js';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, renameSync, unlinkSync } from 'fs';
import { dirname, basename, join } from 'path';
import type {
  StackRecordAdapter,
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
import { applyMergePatch, StackConflictError, StackNotFoundError } from '@haverstack/core';
import {
  RECORD_SCHEMA_SQL,
  FTS4_SCHEMA_SQL,
  PRAGMA_FOREIGN_KEYS_ON,
  buildWhereClause,
  buildOrderClause,
  getSortField,
  makeCursor,
  rowToRecord,
  rowToAssociation,
  rowToType,
  rowToVersion,
  toMs,
  fromMs,
  sanitizeFts4Query,
} from '@haverstack/sqlite-shared';

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

export type TokenInfo = {
  id: string;
  entityId: string;
  label?: string;
  createdAt: Date;
  expiresAt?: Date;
};

const SCHEMA_SQL = `${RECORD_SCHEMA_SQL}\n${FTS4_SCHEMA_SQL}`;

// -------------------------------------------------------
// Storage ownership lock
// -------------------------------------------------------
//
// A stack file is owned by exactly one process at a time (see
// docs/spec.md § Concurrency & storage ownership). The lock file
// sits beside the database and records the PID of its opener.

type LockInfo = { pid: number };

const lockPathFor = (dbPath: string): string => `${dbPath}.lock`;

const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH: no such process — safe to reclaim. Anything else (e.g. EPERM,
    // meaning the process exists but we can't signal it) — assume alive.
    return (err as NodeJS.ErrnoException).code !== 'ESRCH';
  }
};

const acquireLock = (dbPath: string, force?: boolean): void => {
  const lockPath = lockPathFor(dbPath);
  if (existsSync(lockPath)) {
    const info = JSON.parse(readFileSync(lockPath, 'utf-8')) as LockInfo;
    const ownedBySelf = info.pid === process.pid;
    if (!ownedBySelf && !force && isProcessAlive(info.pid)) {
      throw new Error(
        `Stack database at "${dbPath}" is in use by another process (pid ${info.pid}). ` +
          `Connect via its server instead, or pass { force: true } to override.`,
      );
    }
  }
  writeFileSync(lockPath, JSON.stringify({ pid: process.pid } satisfies LockInfo));
};

const releaseLock = (dbPath: string): void => {
  const lockPath = lockPathFor(dbPath);
  if (!existsSync(lockPath)) return;
  try {
    const info = JSON.parse(readFileSync(lockPath, 'utf-8')) as LockInfo;
    if (info.pid === process.pid) unlinkSync(lockPath);
  } catch {
    // Corrupt lock file — remove it rather than leaving storage permanently unopenable.
    unlinkSync(lockPath);
  }
};

// -------------------------------------------------------
// Foreign key enforcement
// -------------------------------------------------------

/** sql.js's SQLite build reports FK violations as a plain Error with this message. */
const isForeignKeyViolation = (err: unknown): boolean =>
  err instanceof Error && err.message.includes('FOREIGN KEY constraint failed');

// -------------------------------------------------------
// SQLiteRecordAdapter
// -------------------------------------------------------

export class SQLiteRecordAdapter implements StackRecordAdapter {
  readonly capabilities: AdapterCapabilities = {
    fullTextSearch: true,
    contentFieldQuery: true,
    sortableFields: ['createdAt', 'updatedAt', 'version'],
  };

  ownerEntityId!: string;
  timezone!: string;

  private db!: Database;

  private constructor(
    private readonly SQL: SqlJsStatic,
    private readonly path: string,
  ) {}

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
    const now = Date.now();
    adapter.db.run(
      `INSERT INTO records (id, type_id, created_at, updated_at, content, version)
       VALUES ('_config', '_config@1', ?, ?, ?, 1)`,
      [now, now, JSON.stringify({ entityId: opts.entityId, timezone: opts.timezone })],
    );
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
    adapter.readConfig();
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

  private readConfig(): void {
    const rows = this.execQuery<{ content: string }>(
      `SELECT content FROM records WHERE id = '_config'`,
    );
    if (!rows.length) throw new Error('Stack database is missing its config record.');
    const content = JSON.parse(rows[0].content) as { entityId: string; timezone?: string };
    this.ownerEntityId = content.entityId;
    this.timezone = content.timezone ?? 'UTC';
  }

  // -------------------------------------------------------
  // Records
  // -------------------------------------------------------

  async createRecord(record: StackRecord): Promise<StackRecord> {
    this.db.run(
      `INSERT INTO records
        (id, type_id, created_at, updated_at, content, version,
         parent_id, entity_id, app_id, deleted_at, permissions)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        record.id,
        record.typeId,
        toMs(record.createdAt),
        toMs(record.updatedAt),
        JSON.stringify(record.content),
        record.version,
        record.parentId ?? null,
        record.entityId ?? null,
        record.appId ?? null,
        record.deletedAt ? toMs(record.deletedAt) : null,
        record.permissions ? JSON.stringify(record.permissions) : null,
      ],
    );

    if (record.associations?.length) {
      this.insertAssociations(record.id, record.associations);
    }

    this.updateFts(record.id, JSON.stringify(record.content));
    this.persist();
    return record;
  }

  async getRecord(id: string): Promise<StackRecord | null> {
    const stmt = this.db.prepare('SELECT * FROM records r WHERE r.id = ?');
    stmt.bind([id]);
    if (!stmt.step()) {
      stmt.free();
      return null;
    }
    const row = stmt.getAsObject();
    stmt.free();
    const associations = this.getAssociationsForRecord(id);
    return rowToRecord(row, associations);
  }

  async patchContent(id: string, patch: Record<string, unknown | null>): Promise<StackRecord> {
    const existing = await this.getRecord(id);
    if (!existing) throw new Error(`Record not found: "${id}"`);

    const merged = applyMergePatch(existing.content, patch);
    this.db.run(
      'UPDATE records SET content = ?, version = version + 1, updated_at = ? WHERE id = ?',
      [JSON.stringify(merged), toMs(new Date()), id],
    );
    this.updateFts(id, JSON.stringify(merged));
    this.persist();

    const updated = await this.getRecord(id);
    if (!updated) throw new Error(`Record not found after patchContent: "${id}"`);
    return updated;
  }

  async deleteRecord(id: string, opts: { hard?: boolean } = {}): Promise<void> {
    if (opts.hard) {
      this.hardDeleteRecord(id);
    } else {
      this.db.run(
        'UPDATE records SET deleted_at = ?, version = version + 1, updated_at = ? WHERE id = ?',
        [toMs(new Date()), toMs(new Date()), id],
      );
    }
    this.persist();
  }

  /** Deletes a record's associations, versions, FTS entry, and row — no persist(). */
  private hardDeleteRecord(id: string): void {
    this.db.run('DELETE FROM associations WHERE record_id = ?', [id]);
    this.db.run('DELETE FROM versions WHERE record_id = ?', [id]);
    this.db.run(`DELETE FROM records_fts WHERE docid = (SELECT rowid FROM records WHERE id = ?)`, [
      id,
    ]);
    this.db.run('DELETE FROM records WHERE id = ?', [id]);
  }

  async undeleteRecord(id: string): Promise<StackRecord> {
    this.db.run(
      'UPDATE records SET deleted_at = NULL, version = version + 1, updated_at = ? WHERE id = ?',
      [toMs(new Date()), id],
    );
    this.persist();

    const updated = await this.getRecord(id);
    if (!updated) throw new Error(`Record not found after undelete: "${id}"`);
    return updated;
  }

  async setPermissions(id: string, permissions: Permission[]): Promise<void> {
    this.db.run(
      'UPDATE records SET permissions = ?, version = version + 1, updated_at = ? WHERE id = ?',
      [permissions.length ? JSON.stringify(permissions) : null, toMs(new Date()), id],
    );
    this.persist();
  }

  async restoreVersion(id: string, version: number): Promise<StackRecord> {
    const target = await this.getVersion(id, version);
    if (!target) throw new Error(`Version not found: ${id}@${version}`);

    this.db.run(
      'UPDATE records SET content = ?, version = version + 1, updated_at = ? WHERE id = ?',
      [JSON.stringify(target.content), toMs(new Date()), id],
    );
    if (target.associations !== undefined) {
      this.db.run('DELETE FROM associations WHERE record_id = ?', [id]);
      if (target.associations.length) this.insertAssociations(id, target.associations);
    }
    this.updateFts(id, JSON.stringify(target.content));
    this.persist();

    const updated = await this.getRecord(id);
    if (!updated) throw new Error(`Record not found after restoreVersion: "${id}"`);
    return updated;
  }

  async commitMigration(
    id: string,
    toTypeId: TypeId,
    content: Record<string, unknown>,
  ): Promise<StackRecord> {
    this.db.run(
      'UPDATE records SET type_id = ?, content = ?, version = version + 1, updated_at = ? WHERE id = ?',
      [toTypeId, JSON.stringify(content), toMs(new Date()), id],
    );
    this.updateFts(id, JSON.stringify(content));
    this.persist();

    const updated = await this.getRecord(id);
    if (!updated) throw new Error(`Record not found after commitMigration: "${id}"`);
    return updated;
  }

  async queryRecords(query: StackQuery): Promise<QueryResult> {
    const { sql: where, params } = buildWhereClause(query, sanitizeFts4Query);
    const order = buildOrderClause(query);
    const limit = query.limit ?? 50;

    // Fetch one extra to determine if there's a next page
    const rows = this.execQuery<Record<string, unknown>>(
      `SELECT r.* FROM records r ${where} ${order} LIMIT ?`,
      [...params, limit + 1],
    );

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    const records = page.map((row) => {
      const associations = this.getAssociationsForRecord(row.id as string);
      return rowToRecord(row, associations);
    });

    // Total count (without pagination)
    const countRows = this.execQuery<{ total: number }>(
      `SELECT COUNT(*) as total FROM records r ${where}`,
      params,
    );
    const total = countRows[0]?.total ?? 0;

    const lastRecord = records[records.length - 1];
    const cursor = hasMore && lastRecord ? makeCursor(lastRecord, getSortField(query)) : null;

    return { records, cursor, total };
  }

  /**
   * Atomically verify fileId is unreferenced, then hard-delete every
   * metadataTypeId record whose content.fileId matches it. See
   * StackRecordAdapter.deleteUnreferencedAttachmentRecords(). Runs as a
   * real SQL transaction and, being entirely synchronous SQLite calls
   * with no `await` in between, nothing else can interleave between the
   * reference check and the deletes.
   */
  async deleteUnreferencedAttachmentRecords(
    fileId: FileId,
    metadataTypeId: TypeId,
  ): Promise<RecordId[]> {
    this.db.run('BEGIN');
    try {
      const referenced = this.execQuery<{ found: number }>(
        `SELECT 1 as found FROM associations WHERE kind = 'attachment' AND file_id = ? LIMIT 1`,
        [fileId],
      );
      if (referenced.length) {
        throw new StackConflictError('Attachment is still referenced by one or more records');
      }

      const metaRows = this.execQuery<{ id: string }>(
        `SELECT id FROM records WHERE type_id = ? AND json_extract(content, '$.fileId') = ?`,
        [metadataTypeId, fileId],
      );
      const deletedIds = metaRows.map((row) => row.id);
      for (const id of deletedIds) {
        this.hardDeleteRecord(id);
      }

      this.db.run('COMMIT');
      if (deletedIds.length) this.persist();
      return deletedIds;
    } catch (err) {
      this.db.run('ROLLBACK');
      throw err;
    }
  }

  // -------------------------------------------------------
  // Versions
  // -------------------------------------------------------

  async getVersions(id: string): Promise<RecordVersion[]> {
    const rows = this.execQuery<Record<string, unknown>>(
      'SELECT * FROM versions WHERE record_id = ? ORDER BY version DESC',
      [id],
    );
    return rows.map(rowToVersion);
  }

  async getVersion(id: string, version: number): Promise<RecordVersion | null> {
    const rows = this.execQuery<Record<string, unknown>>(
      'SELECT * FROM versions WHERE record_id = ? AND version = ?',
      [id, version],
    );
    return rows.length ? rowToVersion(rows[0]) : null;
  }

  async saveVersion(id: string, version: RecordVersion): Promise<void> {
    this.db.run(
      `INSERT OR IGNORE INTO versions
        (record_id, version, content, updated_at, entity_id, associations, permissions)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        version.version,
        JSON.stringify(version.content),
        toMs(version.updatedAt),
        version.entityId ?? null,
        version.associations ? JSON.stringify(version.associations) : null,
        version.permissions ? JSON.stringify(version.permissions) : null,
      ],
    );
    this.persist();
  }

  // -------------------------------------------------------
  // Types
  // -------------------------------------------------------

  async saveType(type: StackType): Promise<void> {
    this.db.run(
      `INSERT OR REPLACE INTO types
        (id, base_id, version, name, schema, schema_hash, migrates_from, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        type.id,
        type.baseId,
        type.version,
        type.name,
        JSON.stringify(type.schema),
        type.schemaHash,
        type.migratesFrom ?? null,
        toMs(type.createdAt),
      ],
    );
    this.persist();
  }

  async getType(id: TypeId): Promise<StackType | null> {
    const rows = this.execQuery<Record<string, unknown>>('SELECT * FROM types WHERE id = ?', [id]);
    return rows.length ? rowToType(rows[0]) : null;
  }

  async listTypes(): Promise<StackType[]> {
    const rows = this.execQuery<Record<string, unknown>>(
      'SELECT * FROM types ORDER BY base_id, version',
    );
    return rows.map(rowToType);
  }

  // -------------------------------------------------------
  // Tokens
  // -------------------------------------------------------

  async createToken(
    entityId: string,
    opts: { label?: string; expiresAt?: Date } = {},
  ): Promise<{ id: string; token: string }> {
    const id = randomBytes(8).toString('hex');
    const token = randomBytes(32).toString('hex');
    const tokenHash = createHash('sha256').update(token).digest('hex');
    this.db.run(
      'INSERT INTO tokens (id, token_hash, entity_id, label, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
      [
        id,
        tokenHash,
        entityId,
        opts.label ?? null,
        toMs(new Date()),
        opts.expiresAt ? toMs(opts.expiresAt) : null,
      ],
    );
    this.persist();
    return { id, token };
  }

  async lookupToken(token: string): Promise<{ entityId: string } | null> {
    const hash = createHash('sha256').update(token).digest('hex');
    const rows = this.execQuery<{ entity_id: string; expires_at: number | null }>(
      'SELECT entity_id, expires_at FROM tokens WHERE token_hash = ?',
      [hash],
    );
    if (!rows.length) return null;
    const row = rows[0];
    if (row.expires_at !== null && Date.now() > row.expires_at) return null;
    return { entityId: row.entity_id };
  }

  async listTokens(): Promise<TokenInfo[]> {
    const rows = this.execQuery<{
      id: string;
      entity_id: string;
      label: string | null;
      created_at: number;
      expires_at: number | null;
    }>('SELECT id, entity_id, label, created_at, expires_at FROM tokens ORDER BY created_at DESC');
    return rows.map((row) => ({
      id: row.id,
      entityId: row.entity_id,
      ...(row.label && { label: row.label }),
      createdAt: fromMs(row.created_at),
      ...(row.expires_at !== null && { expiresAt: fromMs(row.expires_at) }),
    }));
  }

  async revokeToken(id: string): Promise<void> {
    this.db.run('DELETE FROM tokens WHERE id = ?', [id]);
    this.persist();
  }

  // -------------------------------------------------------
  // Associations
  // -------------------------------------------------------

  async associate(recordId: string, association: Association): Promise<void> {
    this.insertAssociations(recordId, [association]);
    this.bumpVersion(recordId);
    this.persist();
  }

  async dissociate(recordId: string, association: Association): Promise<void> {
    this.db.run(
      `DELETE FROM associations
       WHERE record_id = ?
         AND kind = ?
         AND label = ?
         AND file_id    = ?
         AND related_id = ?`,
      [
        recordId,
        association.kind,
        association.label,
        association.kind === 'attachment' ? association.fileId : '',
        association.kind === 'relationship' ? association.recordId : '',
      ],
    );
    this.bumpVersion(recordId);
    this.persist();
  }

  private bumpVersion(id: string): void {
    this.db.run('UPDATE records SET version = version + 1, updated_at = ? WHERE id = ?', [
      toMs(new Date()),
      id,
    ]);
  }

  /**
   * FK enforcement (PRAGMA_FOREIGN_KEYS_ON) means inserting an
   * association against a record that doesn't exist throws — mapped
   * here to StackNotFoundError so associate() on a nonexistent record
   * fails loudly with a proper error instead of silently creating an
   * orphan row.
   */
  private insertAssociations(recordId: string, associations: Association[]): void {
    for (const assoc of associations) {
      try {
        this.db.run(
          `INSERT OR IGNORE INTO associations
            (record_id, kind, label, file_id, mime_type, related_id)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [
            recordId,
            assoc.kind,
            assoc.label,
            assoc.kind === 'attachment' ? assoc.fileId : '',
            assoc.kind === 'attachment' ? assoc.mimeType : null,
            assoc.kind === 'relationship' ? assoc.recordId : '',
          ],
        );
      } catch (err) {
        if (isForeignKeyViolation(err)) {
          throw new StackNotFoundError(`Record not found: "${recordId}"`);
        }
        throw err;
      }
    }
  }

  private getAssociationsForRecord(recordId: string): Association[] {
    const rows = this.execQuery<Record<string, unknown>>(
      'SELECT * FROM associations WHERE record_id = ?',
      [recordId],
    );
    return rows.map(rowToAssociation);
  }

  private updateFts(recordId: string, content: string): void {
    // FTS4 content table — delete old entry then insert new one
    this.db.run(`DELETE FROM records_fts WHERE docid = (SELECT rowid FROM records WHERE id = ?)`, [
      recordId,
    ]);
    this.db.run(
      `INSERT INTO records_fts(docid, content)
       SELECT rowid, ? FROM records WHERE id = ?`,
      [content, recordId],
    );
  }

  private execQuery<T>(sql: string, params: unknown[] = []): T[] {
    const stmt = this.db.prepare(sql);
    stmt.bind(params as import('sql.js').BindParams);
    const results: T[] = [];
    while (stmt.step()) {
      results.push(stmt.getAsObject() as T);
    }
    stmt.free();
    return results;
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
