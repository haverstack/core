/**
 * Stack — SQLite Adapter
 * -------------------------------------------------------
 * Implements StackAdapter using sql.js (SQLite compiled to
 * WebAssembly). Runs in Node, browsers, and other runtimes
 * without native compilation.
 *
 * The database is held in memory and flushed to disk on every
 * write. Attachments are stored as extension-less files in an
 * `attachments/` subdirectory next to the database file.
 * File IDs are SHA-256 hashes of the content; the filesystem
 * is the authoritative store — no separate DB table is needed.
 *
 * Stack config (timezone, entity_id, etc.) is stored in a
 * `stack_config` key/value table.
 */

import initSqlJs from 'sql.js';
import type { Database, SqlJsStatic } from 'sql.js';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { readFile, writeFile, unlink } from 'fs/promises';
import { join, dirname } from 'path';
import type {
  StackAdapter,
  StackRecord,
  StackType,
  TypeId,
  RecordVersion,
  StackQuery,
  QueryResult,
  Association,
  AdapterCapabilities,
} from '@haverstack/core';

// -------------------------------------------------------
// Types
// -------------------------------------------------------

export type SQLiteInitializeOptions = {
  /** Absolute path to the .db file. Must not already exist. */
  path: string;
  /** IANA timezone string e.g. "America/New_York". */
  timezone: string;
  /** Entity ID of the stack owner. */
  entityId: string;
};

export type SQLiteOpenOptions = {
  /** Absolute path to an existing .db file. */
  path: string;
};

export type TokenInfo = {
  id: string;
  entityId: string;
  label?: string;
  createdAt: Date;
  expiresAt?: Date;
};

// -------------------------------------------------------
// SQL — schema
// -------------------------------------------------------

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS records (
    id          TEXT PRIMARY KEY,
    type_id     TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL,
    content     TEXT NOT NULL CHECK (json_valid(content)),
    version     INTEGER NOT NULL DEFAULT 1,
    parent_id   TEXT,
    entity_id   TEXT,
    app_id      TEXT,
    deleted_at  INTEGER,
    permissions TEXT CHECK (permissions IS NULL OR json_valid(permissions))
  ) STRICT;

  CREATE TABLE IF NOT EXISTS associations (
    record_id  TEXT NOT NULL REFERENCES records(id),
    kind       TEXT NOT NULL CHECK (kind IN ('tag', 'attachment', 'relationship')),
    label      TEXT NOT NULL,
    file_id    TEXT NOT NULL DEFAULT '',
    mime_type  TEXT,
    related_id TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (record_id, kind, label, file_id, related_id)
  ) STRICT;

  CREATE TABLE IF NOT EXISTS versions (
    record_id  TEXT NOT NULL REFERENCES records(id),
    version    INTEGER NOT NULL,
    content    TEXT NOT NULL CHECK (json_valid(content)),
    updated_at INTEGER NOT NULL,
    entity_id  TEXT,
    PRIMARY KEY (record_id, version)
  ) STRICT;

  CREATE TABLE IF NOT EXISTS types (
    id            TEXT PRIMARY KEY,
    base_id       TEXT NOT NULL,
    version       INTEGER NOT NULL,
    name          TEXT NOT NULL,
    schema        TEXT NOT NULL CHECK (json_valid(schema)),
    schema_hash   TEXT NOT NULL,
    migrates_from TEXT,
    created_at    INTEGER NOT NULL
  ) STRICT;

  CREATE TABLE IF NOT EXISTS tokens (
    id          TEXT PRIMARY KEY,
    token_hash  TEXT NOT NULL UNIQUE,
    entity_id   TEXT NOT NULL,
    label       TEXT,
    created_at  INTEGER NOT NULL,
    expires_at  INTEGER
  ) STRICT;

  -- Indexes
  CREATE INDEX IF NOT EXISTS idx_records_type_id    ON records(type_id);
  CREATE INDEX IF NOT EXISTS idx_records_parent_id  ON records(parent_id);
  CREATE INDEX IF NOT EXISTS idx_records_entity_id  ON records(entity_id);
  CREATE INDEX IF NOT EXISTS idx_records_app_id     ON records(app_id);
  CREATE INDEX IF NOT EXISTS idx_records_deleted_at ON records(deleted_at);
  CREATE INDEX IF NOT EXISTS idx_records_created_at ON records(created_at);
  CREATE INDEX IF NOT EXISTS idx_records_updated_at ON records(updated_at);
  CREATE INDEX IF NOT EXISTS idx_assoc_record_id    ON associations(record_id);
  CREATE INDEX IF NOT EXISTS idx_assoc_kind_label   ON associations(kind, label);
  CREATE INDEX IF NOT EXISTS idx_assoc_kind_file_id ON associations(kind, file_id);
  CREATE INDEX IF NOT EXISTS idx_types_base_id      ON types(base_id);
  CREATE INDEX IF NOT EXISTS idx_tokens_hash        ON tokens(token_hash);

  -- Full-text search (FTS4 — compatible with sql.js)
  CREATE VIRTUAL TABLE IF NOT EXISTS records_fts USING fts4(
    content,
    content='records'
  );
`;

// -------------------------------------------------------
// Helpers
// -------------------------------------------------------

const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

const assertFileId = (fileId: string): void => {
  if (!SHA256_HEX_RE.test(fileId)) {
    throw new Error(`Invalid fileId: expected 64-character lowercase hex string`);
  }
};

// -------------------------------------------------------
// Row <-> domain object mapping
// -------------------------------------------------------

const toMs = (d: Date): number => d.getTime();
const fromMs = (ms: number): Date => new Date(ms);

const rowToRecord = (row: Record<string, unknown>, associations: Association[]): StackRecord => {
  const record: StackRecord = {
    id: row.id as string,
    typeId: row.type_id as string,
    createdAt: fromMs(row.created_at as number),
    updatedAt: fromMs(row.updated_at as number),
    content: JSON.parse(row.content as string),
    version: row.version as number,
  };
  if (row.parent_id) record.parentId = row.parent_id as string;
  if (row.entity_id) record.entityId = row.entity_id as string;
  if (row.app_id) record.appId = row.app_id as string;
  if (row.deleted_at) record.deletedAt = fromMs(row.deleted_at as number);
  if (row.permissions) record.permissions = JSON.parse(row.permissions as string);
  if (associations.length) record.associations = associations;
  return record;
};

const rowToAssociation = (row: Record<string, unknown>): Association => {
  if (row.kind === 'tag') {
    return { kind: 'tag', label: row.label as string };
  }
  if (row.kind === 'attachment') {
    return {
      kind: 'attachment',
      label: row.label as string,
      fileId: row.file_id as string,
      mimeType: row.mime_type as string,
    };
  }
  // relationship
  return {
    kind: 'relationship',
    label: row.label as string,
    recordId: row.related_id as string,
  };
};

const rowToType = (row: Record<string, unknown>): StackType => {
  const t: StackType = {
    id: row.id as string,
    baseId: row.base_id as string,
    version: row.version as number,
    name: row.name as string,
    schema: JSON.parse(row.schema as string),
    schemaHash: row.schema_hash as string,
    createdAt: fromMs(row.created_at as number),
  };
  if (row.migrates_from) t.migratesFrom = row.migrates_from as string;
  return t;
};

const rowToVersion = (row: Record<string, unknown>): RecordVersion => {
  const v: RecordVersion = {
    version: row.version as number,
    content: JSON.parse(row.content as string),
    updatedAt: fromMs(row.updated_at as number),
  };
  if (row.entity_id) v.entityId = row.entity_id as string;
  return v;
};

// -------------------------------------------------------
// FTS4 query sanitization
// -------------------------------------------------------

/**
 * Sanitizes user input for safe use in an FTS4 MATCH clause.
 *
 * FTS4's query language supports operators (AND/OR/NOT, phrases, NEAR, wildcards)
 * that can be expensive or cause parse errors with untrusted input.
 * This function removes the dangerous operators while preserving useful ones:
 *   kept:    AND/OR/NOT (with a left operand), phrase queries ("…"), implicit AND
 *   removed: wildcards (*), NEAR/N, bare NOT (no left operand)
 *   capped:  parenthesis nesting depth (default: 2)
 *
 * A query timeout is not implementable here: sql.js runs SQLite as synchronous
 * WASM that blocks the JS event loop, and db.interrupt() is not exposed. Moving
 * sql.js into a Worker thread would enable a timeout via interrupt() but is out
 * of scope for this change.
 */
const sanitizeFts4Query = (query: string, maxDepth = 2): string => {
  if (!query) return '';

  // Remove wildcards
  let clean = query.replace(/\*/g, '');

  // Remove NEAR operator (handles NEAR and NEAR/N variants)
  clean = clean.replace(/\bNEAR(?:\/\d+)?\b/gi, '');

  // Strip bare NOT with no left operand — FTS4 requires "term NOT term", not "NOT term"
  clean = clean.replace(/(?:^|\(\s*)NOT\s+/gi, (m) => m.replace(/NOT\s+/i, ''));

  // Enforce max nesting depth; replace excess ( with a space and discard unmatched )
  let currentDepth = 0;
  let result = '';
  for (const char of clean) {
    if (char === '(') {
      if (currentDepth < maxDepth) {
        currentDepth++;
        result += char;
      } else result += ' ';
    } else if (char === ')') {
      if (currentDepth > 0) {
        currentDepth--;
        result += char;
      } else result += ' ';
    } else {
      result += char;
    }
  }

  // Auto-close any unclosed parens
  if (currentDepth > 0) result += ')'.repeat(currentDepth);

  // Iteratively remove empty paren pairs left behind by NEAR/NOT stripping
  let prev: string;
  do {
    prev = result;
    result = result.replace(/\(\s*\)/g, ' ');
  } while (result !== prev);

  return result.replace(/\s+/g, ' ').replace(/\(\s+/g, '(').replace(/\s+\)/g, ')').trim();
};

// -------------------------------------------------------
// Query building
// -------------------------------------------------------

type SortField = 'createdAt' | 'updatedAt' | 'version';

const getSortField = (query: StackQuery): SortField => query.sort?.field ?? 'createdAt';

const getSortColumn = (field: SortField): string =>
  field === 'createdAt' ? 'created_at' : field === 'updatedAt' ? 'updated_at' : 'version';

const buildWhereClause = (query: StackQuery): { sql: string; params: unknown[] } => {
  const conditions: string[] = ["r.id != '_config'"];
  const params: unknown[] = [];
  const f = query.filter ?? {};

  if (!f.includeDeleted) {
    conditions.push('r.deleted_at IS NULL');
  }

  if (f.typeId !== undefined) {
    const ids = Array.isArray(f.typeId) ? f.typeId : [f.typeId];
    conditions.push(`r.type_id IN (${ids.map(() => '?').join(',')})`);
    params.push(...ids);
  }

  if (f.parentId !== undefined) {
    if (f.parentId === null) {
      conditions.push('r.parent_id IS NULL');
    } else {
      conditions.push('r.parent_id = ?');
      params.push(f.parentId);
    }
  }

  if (f.appId !== undefined) {
    const ids = Array.isArray(f.appId) ? f.appId : [f.appId];
    conditions.push(`r.app_id IN (${ids.map(() => '?').join(',')})`);
    params.push(...ids);
  }

  if (f.entityId !== undefined) {
    const ids = Array.isArray(f.entityId) ? f.entityId : [f.entityId];
    conditions.push(`r.entity_id IN (${ids.map(() => '?').join(',')})`);
    params.push(...ids);
  }

  if (f.createdAt?.after) {
    conditions.push('r.created_at > ?');
    params.push(toMs(f.createdAt.after));
  }
  if (f.createdAt?.before) {
    conditions.push('r.created_at < ?');
    params.push(toMs(f.createdAt.before));
  }
  if (f.updatedAt?.after) {
    conditions.push('r.updated_at > ?');
    params.push(toMs(f.updatedAt.after));
  }
  if (f.updatedAt?.before) {
    conditions.push('r.updated_at < ?');
    params.push(toMs(f.updatedAt.before));
  }

  // Tag filter — record must have ALL specified tags
  if (f.tags?.length) {
    for (const tag of f.tags) {
      conditions.push(
        `EXISTS (SELECT 1 FROM associations a WHERE a.record_id = r.id AND a.kind = 'tag' AND a.label = ?)`,
      );
      params.push(tag);
    }
  }

  // Attachment label filter
  if (f.hasAttachment) {
    conditions.push(
      `EXISTS (SELECT 1 FROM associations a WHERE a.record_id = r.id AND a.kind = 'attachment' AND a.label = ?)`,
    );
    params.push(f.hasAttachment);
  }

  // Attachment file ID filter — find records that reference a specific file
  if (f.attachmentFileId) {
    conditions.push(
      `EXISTS (SELECT 1 FROM associations a WHERE a.record_id = r.id AND a.kind = 'attachment' AND a.file_id = ?)`,
    );
    params.push(f.attachmentFileId);
  }

  // Relationship filter
  if (f.relatedTo) {
    conditions.push(
      `EXISTS (SELECT 1 FROM associations a WHERE a.record_id = r.id AND a.kind = 'relationship' AND a.related_id = ?` +
        (f.relatedTo.label ? ` AND a.label = ?` : '') +
        `)`,
    );
    params.push(f.relatedTo.recordId);
    if (f.relatedTo.label) params.push(f.relatedTo.label);
  }

  // Content field filters (top-level scalar exact match)
  if (f.content) {
    for (const [key, value] of Object.entries(f.content)) {
      conditions.push(`json_extract(r.content, ?) = ?`);
      params.push(`$.${key}`, value);
    }
  }

  if (f.search) {
    const sanitized = sanitizeFts4Query(f.search);
    if (sanitized) {
      conditions.push(`r.rowid IN (SELECT rowid FROM records_fts WHERE records_fts MATCH ?)`);
      params.push(sanitized);
    }
  }

  // Cursor (sort-field value + id for stable pagination)
  if (query.cursor) {
    const parts = Buffer.from(query.cursor, 'base64').toString().split('|');
    // New format: field|value|id (3 parts). Legacy format: value|id (2 parts, implies createdAt).
    const [cursorField, cursorValue, cursorId] =
      parts.length === 3
        ? (parts as [string, string, string])
        : (['createdAt', parts[0], parts[1]] as [string, string, string]);
    const validSortFields: SortField[] = ['createdAt', 'updatedAt', 'version'];
    if (!validSortFields.includes(cursorField as SortField)) {
      throw new Error(`Invalid cursor: unknown sort field "${cursorField}"`);
    }
    const numericValue = Number(cursorValue);
    if (!isFinite(numericValue)) {
      throw new Error(`Invalid cursor: non-numeric sort value`);
    }
    const col = getSortColumn(cursorField as SortField);
    const sortDir = query.sort?.direction ?? 'desc';
    const op = sortDir === 'asc' ? '>' : '<';
    conditions.push(`(r.${col} ${op} ? OR (r.${col} = ? AND r.id ${op} ?))`);
    params.push(numericValue, numericValue, cursorId);
  }

  return {
    sql: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '',
    params,
  };
};

const buildOrderClause = (query: StackQuery): string => {
  const field = getSortField(query);
  const dir = (query.sort?.direction ?? 'desc').toUpperCase();
  return `ORDER BY r.${getSortColumn(field)} ${dir}, r.id ${dir}`;
};

const makeCursor = (record: StackRecord, field: SortField): string => {
  const value =
    field === 'updatedAt'
      ? toMs(record.updatedAt)
      : field === 'version'
        ? record.version
        : toMs(record.createdAt);
  return Buffer.from(`${field}|${value}|${record.id}`).toString('base64');
};

// -------------------------------------------------------
// SQLite adapter
// -------------------------------------------------------

export class SQLiteAdapter implements StackAdapter {
  readonly capabilities: AdapterCapabilities = {
    fullTextSearch: true,
    contentFieldQuery: true,
    sortableFields: ['createdAt', 'updatedAt', 'version'],
  };

  ownerEntityId!: string;
  timezone!: string;

  private db!: Database;
  private readonly attachmentsDir: string;

  private constructor(
    private readonly SQL: SqlJsStatic,
    private readonly path: string,
  ) {
    this.attachmentsDir = join(dirname(path), 'attachments');
  }

  /**
   * Initialize a new stack database. Fails if the file already exists —
   * use open() for existing databases.
   */
  static async initialize(opts: SQLiteInitializeOptions): Promise<SQLiteAdapter> {
    if (existsSync(opts.path)) {
      throw new Error(
        `Cannot initialize: database already exists at "${opts.path}". ` +
          `Use SQLiteAdapter.open() instead.`,
      );
    }
    const SQL = await initSqlJs();
    const adapter = new SQLiteAdapter(SQL, opts.path);
    adapter.db = new SQL.Database();
    adapter.db.run(SCHEMA_SQL);
    adapter.runMigrations();
    mkdirSync(adapter.attachmentsDir, { recursive: true });
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
  static async open(opts: SQLiteOpenOptions): Promise<SQLiteAdapter> {
    if (!existsSync(opts.path)) {
      throw new Error(
        `Cannot open: no database found at "${opts.path}". ` +
          `Use SQLiteAdapter.initialize() to create one.`,
      );
    }
    const SQL = await initSqlJs();
    const adapter = new SQLiteAdapter(SQL, opts.path);
    const fileBuffer = readFileSync(opts.path);
    adapter.db = new SQL.Database(fileBuffer);
    adapter.db.run(SCHEMA_SQL); // safe — all statements use CREATE IF NOT EXISTS
    adapter.runMigrations();
    mkdirSync(adapter.attachmentsDir, { recursive: true });
    adapter.readConfig();
    return adapter;
  }

  // -------------------------------------------------------
  // Persistence
  // -------------------------------------------------------

  /** Flush the in-memory database to disk. Called after every write. */
  private persist(): void {
    const data = this.db.export();
    writeFileSync(this.path, Buffer.from(data));
  }

  // -------------------------------------------------------
  // Schema migrations
  // -------------------------------------------------------

  /**
   * Runs after SCHEMA_SQL to handle databases created before breaking schema
   * changes. Safe to call on both fresh and existing databases.
   */
  private runMigrations(): void {
    // The attachments table is obsolete — binary files are content-addressed on
    // disk and the filesystem is the authoritative source of truth. Drop it if
    // an older database still has it.
    const attachmentCols = this.execQuery<{ name: string }>('PRAGMA table_info(attachments)');
    if (attachmentCols.length) this.db.run('DROP TABLE attachments');

    // stack_config is obsolete — config is now a _config@1 record in the records
    // table. Migrate the data and drop the table if it still exists.
    const configCols = this.execQuery<{ name: string }>('PRAGMA table_info(stack_config)');
    if (configCols.length) {
      const configRows = this.execQuery<{ key: string; value: string }>(
        'SELECT key, value FROM stack_config',
      );
      const cfg: Record<string, string> = {};
      for (const row of configRows) cfg[row.key] = row.value;

      const existing = this.execQuery<{ id: string }>(
        `SELECT id FROM records WHERE id = '_config'`,
      );
      if (!existing.length) {
        const now = Date.now();
        this.db.run(
          `INSERT INTO records (id, type_id, created_at, updated_at, content, version)
           VALUES ('_config', '_config@1', ?, ?, ?, 1)`,
          [now, now, JSON.stringify({ entityId: cfg['entity_id'], timezone: cfg['timezone'] ?? 'UTC' })],
        );
      }
      this.db.run('DROP TABLE stack_config');
    }
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

  async updateRecord(id: string, changes: Partial<StackRecord>): Promise<StackRecord> {
    const setClauses: string[] = [];
    const params: unknown[] = [];

    if (changes.content !== undefined) {
      setClauses.push('content = ?');
      params.push(JSON.stringify(changes.content));
    }
    if (changes.typeId !== undefined) {
      setClauses.push('type_id = ?');
      params.push(changes.typeId);
    }
    if (changes.updatedAt !== undefined) {
      setClauses.push('updated_at = ?');
      params.push(toMs(changes.updatedAt));
    }
    if (changes.version !== undefined) {
      setClauses.push('version = ?');
      params.push(changes.version);
    }
    if (changes.deletedAt !== undefined) {
      setClauses.push('deleted_at = ?');
      params.push(toMs(changes.deletedAt));
    }
    if (changes.permissions !== undefined) {
      setClauses.push('permissions = ?');
      params.push(changes.permissions.length ? JSON.stringify(changes.permissions) : null);
    }

    if (setClauses.length) {
      params.push(id);
      this.db.run(
        `UPDATE records SET ${setClauses.join(', ')} WHERE id = ?`,
        params as import('sql.js').BindParams,
      );
    }

    // Replace associations if provided
    if (changes.associations !== undefined) {
      this.db.run('DELETE FROM associations WHERE record_id = ?', [id]);
      if (changes.associations.length) {
        this.insertAssociations(id, changes.associations);
      }
    }

    if (changes.content !== undefined) {
      this.updateFts(id, JSON.stringify(changes.content));
    }

    this.persist();

    const updated = await this.getRecord(id);
    if (!updated) throw new Error(`Record not found after update: "${id}"`);
    return updated;
  }

  async deleteRecord(id: string, opts: { hard?: boolean } = {}): Promise<void> {
    if (opts.hard) {
      this.db.run('DELETE FROM associations WHERE record_id = ?', [id]);
      this.db.run('DELETE FROM versions WHERE record_id = ?', [id]);
      this.db.run(
        `DELETE FROM records_fts WHERE docid = (SELECT rowid FROM records WHERE id = ?)`,
        [id],
      );
      this.db.run('DELETE FROM records WHERE id = ?', [id]);
    } else {
      this.db.run('UPDATE records SET deleted_at = ? WHERE id = ?', [toMs(new Date()), id]);
    }
    this.persist();
  }

  async queryRecords(query: StackQuery): Promise<QueryResult> {
    const { sql: where, params } = buildWhereClause(query);
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
      `INSERT OR IGNORE INTO versions (record_id, version, content, updated_at, entity_id)
       VALUES (?, ?, ?, ?, ?)`,
      [
        id,
        version.version,
        JSON.stringify(version.content),
        toMs(version.updatedAt),
        version.entityId ?? null,
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
  // Attachments
  // -------------------------------------------------------

  async putAttachment(data: Uint8Array): Promise<string> {
    const fileId = createHash('sha256').update(data).digest('hex');
    if (!existsSync(join(this.attachmentsDir, fileId))) {
      await writeFile(join(this.attachmentsDir, fileId), data);
    }
    return fileId;
  }

  async getAttachment(fileId: string): Promise<Uint8Array> {
    assertFileId(fileId);
    if (!existsSync(join(this.attachmentsDir, fileId)))
      throw new Error(`Attachment not found: "${fileId}"`);
    return readFile(join(this.attachmentsDir, fileId));
  }

  async deleteAttachment(fileId: string): Promise<void> {
    assertFileId(fileId);
    try {
      await unlink(join(this.attachmentsDir, fileId));
    } catch {
      // Non-fatal — file may already be gone.
    }
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
    this.persist();
  }

  private insertAssociations(recordId: string, associations: Association[]): void {
    for (const assoc of associations) {
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
  }
}
