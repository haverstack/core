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
 * Schema DDL, WHERE/ORDER building, cursor codec, row mappers, and the
 * storage-ownership lock live in @haverstack/sqlite-shared — shared
 * with record-adapter-sqljs so the two engines can't drift on
 * engine-independent logic.
 */

import { DatabaseSync } from './node-sqlite.js';
import { existsSync } from 'fs';
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
  FTS5_SCHEMA_SQL,
  PRAGMA_FOREIGN_KEYS_ON,
  PRAGMA_JOURNAL_MODE_WAL,
  buildWhereClause,
  buildOrderClause,
  getSortField,
  makeCursor,
  rowToRecord,
  rowToAssociation,
  rowToType,
  rowToVersion,
  toMs,
  sanitizeFts5Query,
  acquireLock,
  releaseLock,
} from '@haverstack/sqlite-shared';

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
// Foreign key enforcement
// -------------------------------------------------------

/** node:sqlite reports FK violations as an Error with this message (code ERR_SQLITE_ERROR). */
const isForeignKeyViolation = (err: unknown): boolean =>
  err instanceof Error && err.message.includes('FOREIGN KEY constraint failed');

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
  };

  ownerEntityId!: string;
  timezone!: string;

  private db!: DatabaseSync;

  private constructor(private readonly path: string) {}

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
    const now = Date.now();
    adapter.db
      .prepare(
        `INSERT INTO records (id, type_id, created_at, updated_at, content, version)
         VALUES ('_config', '_config@1', ?, ?, ?, 1)`,
      )
      .run(now, now, JSON.stringify({ entityId: opts.entityId, timezone: opts.timezone }));
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
    adapter.readConfig();
    return adapter;
  }

  private readConfig(): void {
    const row = this.db.prepare(`SELECT content FROM records WHERE id = '_config'`).get() as
      | { content: string }
      | undefined;
    if (!row) throw new Error('Stack database is missing its config record.');
    const content = JSON.parse(row.content) as { entityId: string; timezone?: string };
    this.ownerEntityId = content.entityId;
    this.timezone = content.timezone ?? 'UTC';
  }

  // -------------------------------------------------------
  // Records
  // -------------------------------------------------------

  async createRecord(record: StackRecord): Promise<StackRecord> {
    this.db
      .prepare(
        `INSERT INTO records
          (id, type_id, created_at, updated_at, content, version,
           parent_id, entity_id, app_id, deleted_at, permissions)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
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
      );

    if (record.associations?.length) {
      this.insertAssociations(record.id, record.associations);
    }

    this.insertFts(record.id, JSON.stringify(record.content));
    return record;
  }

  async getRecord(id: string): Promise<StackRecord | null> {
    const row = this.db.prepare('SELECT * FROM records WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    if (!row) return null;
    const associations = this.getAssociationsForRecord(id);
    return rowToRecord(row, associations);
  }

  async patchContent(id: string, patch: Record<string, unknown | null>): Promise<StackRecord> {
    const existing = await this.getRecord(id);
    if (!existing) throw new Error(`Record not found: "${id}"`);

    const merged = applyMergePatch(existing.content, patch);
    this.removeFts(id);
    this.db
      .prepare('UPDATE records SET content = ?, version = version + 1, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(merged), toMs(new Date()), id);
    this.insertFts(id, JSON.stringify(merged));

    const updated = await this.getRecord(id);
    if (!updated) throw new Error(`Record not found after patchContent: "${id}"`);
    return updated;
  }

  async deleteRecord(id: string, opts: { hard?: boolean } = {}): Promise<void> {
    if (opts.hard) {
      this.hardDeleteRecord(id);
    } else {
      this.db
        .prepare(
          'UPDATE records SET deleted_at = ?, version = version + 1, updated_at = ? WHERE id = ?',
        )
        .run(toMs(new Date()), toMs(new Date()), id);
    }
  }

  /** Deletes a record's associations, versions, FTS entry, and row. */
  private hardDeleteRecord(id: string): void {
    this.removeFts(id);
    this.db.prepare('DELETE FROM associations WHERE record_id = ?').run(id);
    this.db.prepare('DELETE FROM versions WHERE record_id = ?').run(id);
    this.db.prepare('DELETE FROM records WHERE id = ?').run(id);
  }

  async undeleteRecord(id: string): Promise<StackRecord> {
    this.db
      .prepare(
        'UPDATE records SET deleted_at = NULL, version = version + 1, updated_at = ? WHERE id = ?',
      )
      .run(toMs(new Date()), id);

    const updated = await this.getRecord(id);
    if (!updated) throw new Error(`Record not found after undelete: "${id}"`);
    return updated;
  }

  async setPermissions(id: string, permissions: Permission[]): Promise<void> {
    this.db
      .prepare(
        'UPDATE records SET permissions = ?, version = version + 1, updated_at = ? WHERE id = ?',
      )
      .run(permissions.length ? JSON.stringify(permissions) : null, toMs(new Date()), id);
  }

  async restoreVersion(id: string, version: number): Promise<StackRecord> {
    const target = await this.getVersion(id, version);
    if (!target) throw new Error(`Version not found: ${id}@${version}`);

    this.removeFts(id);
    this.db
      .prepare('UPDATE records SET content = ?, version = version + 1, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(target.content), toMs(new Date()), id);
    if (target.associations !== undefined) {
      this.db.prepare('DELETE FROM associations WHERE record_id = ?').run(id);
      if (target.associations.length) this.insertAssociations(id, target.associations);
    }
    this.insertFts(id, JSON.stringify(target.content));

    const updated = await this.getRecord(id);
    if (!updated) throw new Error(`Record not found after restoreVersion: "${id}"`);
    return updated;
  }

  async commitMigration(
    id: string,
    toTypeId: TypeId,
    content: Record<string, unknown>,
  ): Promise<StackRecord> {
    this.removeFts(id);
    this.db
      .prepare(
        'UPDATE records SET type_id = ?, content = ?, version = version + 1, updated_at = ? WHERE id = ?',
      )
      .run(toTypeId, JSON.stringify(content), toMs(new Date()), id);
    this.insertFts(id, JSON.stringify(content));

    const updated = await this.getRecord(id);
    if (!updated) throw new Error(`Record not found after commitMigration: "${id}"`);
    return updated;
  }

  async queryRecords(query: StackQuery): Promise<QueryResult> {
    const { sql: where, params } = buildWhereClause(query, sanitizeFts5Query);
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
    this.db.exec('BEGIN');
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

      this.db.exec('COMMIT');
      return deletedIds;
    } catch (err) {
      this.db.exec('ROLLBACK');
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
    this.db
      .prepare(
        `INSERT OR IGNORE INTO versions
          (record_id, version, content, updated_at, entity_id, associations, permissions)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        version.version,
        JSON.stringify(version.content),
        toMs(version.updatedAt),
        version.entityId ?? null,
        version.associations ? JSON.stringify(version.associations) : null,
        version.permissions ? JSON.stringify(version.permissions) : null,
      );
  }

  // -------------------------------------------------------
  // Types
  // -------------------------------------------------------

  async saveType(type: StackType): Promise<void> {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO types
          (id, base_id, version, name, schema, schema_hash, migrates_from, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        type.id,
        type.baseId,
        type.version,
        type.name,
        JSON.stringify(type.schema),
        type.schemaHash,
        type.migratesFrom ?? null,
        toMs(type.createdAt),
      );
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
  // Associations
  // -------------------------------------------------------

  async associate(recordId: string, association: Association): Promise<void> {
    this.insertAssociations(recordId, [association]);
    this.bumpVersion(recordId);
  }

  async dissociate(recordId: string, association: Association): Promise<void> {
    this.db
      .prepare(
        `DELETE FROM associations
         WHERE record_id = ?
           AND kind = ?
           AND label = ?
           AND file_id    = ?
           AND related_id = ?`,
      )
      .run(
        recordId,
        association.kind,
        association.label,
        association.kind === 'attachment' ? association.fileId : '',
        association.kind === 'relationship' ? association.recordId : '',
      );
    this.bumpVersion(recordId);
  }

  private bumpVersion(id: string): void {
    this.db
      .prepare('UPDATE records SET version = version + 1, updated_at = ? WHERE id = ?')
      .run(toMs(new Date()), id);
  }

  /**
   * FK enforcement (PRAGMA_FOREIGN_KEYS_ON) means inserting an
   * association against a record that doesn't exist throws — mapped
   * here to StackNotFoundError so associate() on a nonexistent record
   * fails loudly instead of silently creating an orphan row.
   */
  private insertAssociations(recordId: string, associations: Association[]): void {
    for (const assoc of associations) {
      try {
        this.db
          .prepare(
            `INSERT OR IGNORE INTO associations
              (record_id, kind, label, file_id, mime_type, related_id)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(
            recordId,
            assoc.kind,
            assoc.label,
            assoc.kind === 'attachment' ? assoc.fileId : '',
            assoc.kind === 'attachment' ? assoc.mimeType : null,
            assoc.kind === 'relationship' ? assoc.recordId : '',
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

  /** Index a record that has no FTS entry yet (used right after an INSERT). */
  private insertFts(recordId: string, content: string): void {
    this.db
      .prepare(`INSERT INTO records_fts(rowid, content) SELECT rowid, ? FROM records WHERE id = ?`)
      .run(content, recordId);
  }

  /**
   * Remove a record's FTS entry via FTS5's special 'delete' command,
   * which — for an external-content table — needs the *old* rowid and
   * content to correctly unindex it; a plain `DELETE FROM records_fts`
   * leaves stale, still-searchable index entries behind. MUST be called
   * before the records row's content changes or the row is deleted, since
   * it reads the current content to build that command. No-op if the
   * record has no FTS entry (shouldn't happen in practice, but a missing
   * row is not this method's problem to raise).
   */
  private removeFts(recordId: string): void {
    const row = this.db.prepare('SELECT rowid, content FROM records WHERE id = ?').get(recordId) as
      | { rowid: number; content: string }
      | undefined;
    if (!row) return;
    this.db
      .prepare(`INSERT INTO records_fts(records_fts, rowid, content) VALUES('delete', ?, ?)`)
      .run(row.rowid, row.content);
  }

  private execQuery<T>(sql: string, params: unknown[] = []): T[] {
    return this.db.prepare(sql).all(...(params as (string | number | null)[])) as T[];
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
