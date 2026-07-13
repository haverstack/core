/**
 * The actual StackRecordAdapter logic (minus lifecycle: initialize/open/
 * close/flush stay per-engine, since schema setup, pragmas, locking, and
 * durability differ there). Every CRUD/query/version/type/association
 * operation lives here exactly once, parametrized over a SqlExecutor
 * (normalizes sql.js vs node:sqlite's call conventions) and an
 * FtsStrategy (the one place FTS4 and FTS5 genuinely differ). Concrete
 * adapters construct one of these and delegate their StackRecordAdapter
 * methods to it — see record-adapter-sqljs and record-adapter-sqlite.
 */

import { StackConflictError, StackNotFoundError, applyMergePatch } from '@haverstack/core';
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
} from '@haverstack/core';
import type { SqlExecutor } from './executor.js';
import { isForeignKeyViolation } from './executor.js';
import type { FtsStrategy } from './fts-strategy.js';
import { buildWhereClause, buildOrderClause, getSortField } from './query.js';
import type { SanitizeSearch } from './query.js';
import { rowToRecord, rowToAssociation, rowToType, rowToVersion, toMs } from './mappers.js';
import { makeCursor } from './cursor.js';

export type SharedSqlRecordLogicDeps = {
  exec: SqlExecutor;
  fts: FtsStrategy;
  sanitizeSearch: SanitizeSearch;
  /**
   * Called (and awaited) after every mutating operation. Omit for engines
   * with durable writes (e.g. native SQLite/WAL); sql.js uses this to
   * export the database and hand the bytes to the host's persistence
   * (temp-file-and-rename on Node, or a caller-supplied async callback
   * for the browser build — hence this may return a Promise).
   */
  onWrite?: () => void | Promise<void>;
};

export class SharedSqlRecordLogic {
  constructor(private readonly deps: SharedSqlRecordLogicDeps) {}

  private get exec(): SqlExecutor {
    return this.deps.exec;
  }

  private get fts(): FtsStrategy {
    return this.deps.fts;
  }

  private async write(): Promise<void> {
    await this.deps.onWrite?.();
  }

  // -------------------------------------------------------
  // Records
  // -------------------------------------------------------

  async createRecord(record: StackRecord): Promise<StackRecord> {
    this.exec.run(
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

    this.fts.insert(this.exec, record.id, JSON.stringify(record.content));
    this.syncFileRefs(record.id, record.typeId, record.content);
    await this.write();
    return record;
  }

  async getRecord(id: string): Promise<StackRecord | null> {
    const row = this.exec.get<Record<string, unknown>>('SELECT * FROM records WHERE id = ?', [id]);
    if (!row) return null;
    const associations = this.getAssociationsForRecord(id);
    return rowToRecord(row, associations);
  }

  async patchContent(id: string, patch: Record<string, unknown | null>): Promise<StackRecord> {
    const existing = await this.getRecord(id);
    if (!existing) throw new Error(`Record not found: "${id}"`);

    const merged = applyMergePatch(existing.content, patch);
    this.fts.remove(this.exec, id);
    this.exec.run(
      'UPDATE records SET content = ?, version = version + 1, updated_at = ? WHERE id = ?',
      [JSON.stringify(merged), toMs(new Date()), id],
    );
    this.fts.insert(this.exec, id, JSON.stringify(merged));
    this.syncFileRefs(id, existing.typeId, merged);
    await this.write();

    const updated = await this.getRecord(id);
    if (!updated) throw new Error(`Record not found after patchContent: "${id}"`);
    return updated;
  }

  async deleteRecord(id: string, opts: { hard?: boolean } = {}): Promise<void> {
    if (opts.hard) {
      this.hardDeleteRecord(id);
    } else {
      this.exec.run(
        'UPDATE records SET deleted_at = ?, version = version + 1, updated_at = ? WHERE id = ?',
        [toMs(new Date()), toMs(new Date()), id],
      );
    }
    await this.write();
  }

  /** Deletes a record's FTS entry, associations, versions, file-refs, and row. No write() call — callers batch it. */
  private hardDeleteRecord(id: string): void {
    this.fts.remove(this.exec, id);
    this.exec.run('DELETE FROM associations WHERE record_id = ?', [id]);
    this.exec.run('DELETE FROM versions WHERE record_id = ?', [id]);
    this.exec.run('DELETE FROM file_refs WHERE record_id = ?', [id]);
    this.exec.run('DELETE FROM records WHERE id = ?', [id]);
  }

  async undeleteRecord(id: string): Promise<StackRecord> {
    this.exec.run(
      'UPDATE records SET deleted_at = NULL, version = version + 1, updated_at = ? WHERE id = ?',
      [toMs(new Date()), id],
    );
    await this.write();

    const updated = await this.getRecord(id);
    if (!updated) throw new Error(`Record not found after undelete: "${id}"`);
    return updated;
  }

  async setPermissions(id: string, permissions: Permission[]): Promise<void> {
    this.exec.run(
      'UPDATE records SET permissions = ?, version = version + 1, updated_at = ? WHERE id = ?',
      [permissions.length ? JSON.stringify(permissions) : null, toMs(new Date()), id],
    );
    await this.write();
  }

  async restoreVersion(id: string, version: number): Promise<StackRecord> {
    const target = await this.getVersion(id, version);
    if (!target) throw new Error(`Version not found: ${id}@${version}`);

    this.fts.remove(this.exec, id);
    this.exec.run(
      'UPDATE records SET type_id = ?, content = ?, version = version + 1, updated_at = ? WHERE id = ?',
      [target.typeId, JSON.stringify(target.content), toMs(new Date()), id],
    );
    if (target.associations !== undefined) {
      this.exec.run('DELETE FROM associations WHERE record_id = ?', [id]);
      if (target.associations.length) this.insertAssociations(id, target.associations);
    }
    this.fts.insert(this.exec, id, JSON.stringify(target.content));
    this.syncFileRefs(id, target.typeId, target.content);
    await this.write();

    const updated = await this.getRecord(id);
    if (!updated) throw new Error(`Record not found after restoreVersion: "${id}"`);
    return updated;
  }

  async commitMigration(
    id: string,
    toTypeId: TypeId,
    content: Record<string, unknown>,
  ): Promise<StackRecord> {
    this.fts.remove(this.exec, id);
    this.exec.run(
      'UPDATE records SET type_id = ?, content = ?, version = version + 1, updated_at = ? WHERE id = ?',
      [toTypeId, JSON.stringify(content), toMs(new Date()), id],
    );
    this.fts.insert(this.exec, id, JSON.stringify(content));
    this.syncFileRefs(id, toTypeId, content);
    await this.write();

    const updated = await this.getRecord(id);
    if (!updated) throw new Error(`Record not found after commitMigration: "${id}"`);
    return updated;
  }

  async queryRecords(query: StackQuery): Promise<QueryResult> {
    const { sql: where, params } = buildWhereClause(query, this.deps.sanitizeSearch);
    const order = buildOrderClause(query);
    const limit = query.limit ?? 50;

    // Fetch one extra to determine if there's a next page
    const rows = this.exec.all<Record<string, unknown>>(
      `SELECT r.* FROM records r ${where} ${order} LIMIT ?`,
      [...params, limit + 1],
    );

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    const records = page.map((row) => {
      const associations = this.getAssociationsForRecord(row.id as string);
      return rowToRecord(row, associations);
    });

    const countRows = this.exec.all<{ total: number }>(
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
   * real SQL transaction and, being entirely synchronous SQL calls with
   * no `await` in between, nothing else can interleave between the
   * reference check and the deletes.
   */
  async deleteUnreferencedAttachmentRecords(
    fileId: FileId,
    metadataTypeId: TypeId,
  ): Promise<RecordId[]> {
    this.exec.exec('BEGIN');
    try {
      const referenced = this.exec.all<{ found: number }>(
        `SELECT 1 as found FROM associations WHERE kind = 'attachment' AND file_id = ?
         UNION ALL
         SELECT 1 FROM file_refs WHERE file_id = ?
         LIMIT 1`,
        [fileId, fileId],
      );
      if (referenced.length) {
        throw new StackConflictError('Attachment is still referenced by one or more records');
      }

      const metaRows = this.exec.all<{ id: string }>(
        `SELECT id FROM records WHERE type_id = ? AND json_extract(content, '$.fileId') = ?`,
        [metadataTypeId, fileId],
      );
      const deletedIds = metaRows.map((row) => row.id);
      for (const id of deletedIds) {
        this.hardDeleteRecord(id);
      }

      this.exec.exec('COMMIT');
      if (deletedIds.length) await this.write();
      return deletedIds;
    } catch (err) {
      this.exec.exec('ROLLBACK');
      throw err;
    }
  }

  // -------------------------------------------------------
  // Versions
  // -------------------------------------------------------

  async getVersions(id: string): Promise<RecordVersion[]> {
    const rows = this.exec.all<Record<string, unknown>>(
      'SELECT * FROM versions WHERE record_id = ? ORDER BY version DESC',
      [id],
    );
    return rows.map(rowToVersion);
  }

  async getVersion(id: string, version: number): Promise<RecordVersion | null> {
    const rows = this.exec.all<Record<string, unknown>>(
      'SELECT * FROM versions WHERE record_id = ? AND version = ?',
      [id, version],
    );
    return rows.length ? rowToVersion(rows[0]) : null;
  }

  async saveVersion(id: string, version: RecordVersion): Promise<void> {
    this.exec.run(
      `INSERT OR IGNORE INTO versions
        (record_id, version, type_id, content, updated_at, entity_id, associations, permissions)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        version.version,
        version.typeId,
        JSON.stringify(version.content),
        toMs(version.updatedAt),
        version.entityId ?? null,
        version.associations ? JSON.stringify(version.associations) : null,
        version.permissions ? JSON.stringify(version.permissions) : null,
      ],
    );
    await this.write();
  }

  // -------------------------------------------------------
  // Types
  // -------------------------------------------------------

  async saveType(type: StackType): Promise<void> {
    this.exec.run(
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
    await this.write();
  }

  async getType(id: TypeId): Promise<StackType | null> {
    const rows = this.exec.all<Record<string, unknown>>('SELECT * FROM types WHERE id = ?', [id]);
    return rows.length ? rowToType(rows[0]) : null;
  }

  async listTypes(): Promise<StackType[]> {
    const rows = this.exec.all<Record<string, unknown>>(
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
    await this.write();
  }

  async dissociate(recordId: string, association: Association): Promise<void> {
    this.exec.run(
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
    await this.write();
  }

  private bumpVersion(id: string): void {
    this.exec.run('UPDATE records SET version = version + 1, updated_at = ? WHERE id = ?', [
      toMs(new Date()),
      id,
    ]);
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
        this.exec.run(
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
    const rows = this.exec.all<Record<string, unknown>>(
      'SELECT * FROM associations WHERE record_id = ?',
      [recordId],
    );
    return rows.map(rowToAssociation);
  }

  /**
   * Replace a record's file_refs rows with whatever its content currently
   * holds in top-level file-ref fields, per its type's schema. Called on
   * every write that can change content or typeId, so the index never
   * drifts from what's actually stored. Only top-level scalars are
   * indexed — same limit as content-field query filtering generally.
   */
  private syncFileRefs(recordId: string, typeId: string, content: Record<string, unknown>): void {
    this.exec.run('DELETE FROM file_refs WHERE record_id = ?', [recordId]);

    const typeRow = this.exec.get<{ schema: string }>('SELECT schema FROM types WHERE id = ?', [
      typeId,
    ]);
    if (!typeRow) return;

    const schema = JSON.parse(typeRow.schema) as Record<string, { kind?: string }>;
    for (const [field, def] of Object.entries(schema)) {
      if (def.kind !== 'file-ref') continue;
      const value = content[field];
      if (typeof value === 'string') {
        this.exec.run(
          'INSERT OR IGNORE INTO file_refs (record_id, field, file_id) VALUES (?, ?, ?)',
          [recordId, field, value],
        );
      }
    }
  }
}
