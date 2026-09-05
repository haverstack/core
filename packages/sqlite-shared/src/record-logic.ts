/**
 * The actual StackRecordAdapter logic (minus lifecycle: initialize/open/
 * close/flush stay per-engine, since schema setup, pragmas, locking, and
 * durability differ there). Every CRUD/query/version/type/association
 * operation lives here exactly once, parametrized over a SqlExecutor
 * (which normalizes each engine's call conventions). Concrete adapters
 * construct one of these and delegate their StackRecordAdapter methods
 * to it — see record-adapter-sqlite.
 */

import {
  StackConflictError,
  StackVersionConflictError,
  StackNotFoundError,
  StackQueryError,
  applyMergePatch,
} from '@haverstack/core';
import type {
  StackRecord,
  StackType,
  TypeId,
  FileId,
  RecordVersion,
  StackQuery,
  QueryResult,
  Association,
  Permission,
  ActorOptions,
  ExpectedVersionOptions,
} from '@haverstack/core';
import type { SqlExecutor } from './executor.js';
import { isForeignKeyViolation, isUniqueConstraintViolation } from './executor.js';
import { buildWhereClause, buildOrderClause, getSortField } from './query.js';
import { fts5Strategy } from './fts5.js';
import {
  rowToRecord,
  rowToAssociation,
  rowToType,
  rowToVersion,
  toMs,
  associationKeyColumns,
} from './mappers.js';
import { makeCursor } from './cursor.js';

/**
 * Run a query statement, restating an engine parse error as the wire
 * taxonomy's `bad_request` rather than letting it escape as a raw engine
 * error (which a server has no code to map, so it becomes a 500).
 *
 * Scoped to the one filter that carries a query language: `filter.search`
 * is FTS5 source text, and sanitizeFts5Query() repairs the common shapes
 * but claims no completeness against the grammar. Every other clause here
 * is built from parameters, so a parse error in one is this module's bug —
 * rethrown untouched, where it belongs.
 */
const asStackQueryError = <T>(query: StackQuery, run: () => T): T => {
  try {
    return run();
  } catch (err) {
    if (!query.filter?.search) throw err;
    throw new StackQueryError(
      `Search text could not be parsed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
};

export type SharedSqlRecordLogicDeps = {
  exec: SqlExecutor;
};

/** Top-level field names in `schema` whose kind is 'file-ref'. */
const fileRefFieldNames = (schema: Record<string, { kind?: string }>): string[] =>
  Object.keys(schema).filter((field) => schema[field].kind === 'file-ref');

export class SharedSqlRecordLogic {
  /**
   * Per-typeId cache of file-ref field names, so syncFileRefs() doesn't
   * hit the `types` table and re-parse schema JSON on every write.
   * Populated eagerly in saveType() and lazily via getFileRefFields().
   */
  private readonly fileRefFieldsByType = new Map<string, string[]>();

  constructor(private readonly deps: SharedSqlRecordLogicDeps) {}

  private get exec(): SqlExecutor {
    return this.deps.exec;
  }

  /**
   * SQL fragment (plus its bind params) that gates a records-table
   * UPDATE/DELETE on the opt-in `expectedVersion` precondition. Empty when
   * expectedVersion is omitted, keeping today's unconditional behavior.
   */
  private versionGuard(expectedVersion: number | undefined): { clause: string; params: unknown[] } {
    return expectedVersion === undefined
      ? { clause: '', params: [] }
      : { clause: ' AND version = ?', params: [expectedVersion] };
  }

  /**
   * Precondition check for mutations that can't fold expectedVersion into
   * their primary UPDATE's WHERE clause: patchContent/restoreVersion need
   * fts.remove() to run *before* the records-table content changes, so
   * the check happens first, standalone.
   */
  private checkExpectedVersion(record: StackRecord, expectedVersion: number | undefined): void {
    if (expectedVersion === undefined || record.version === expectedVersion) return;
    throw new StackVersionConflictError(
      `Record "${record.id}" is at version ${record.version}, expected ${expectedVersion}`,
      record.id,
      expectedVersion,
      record.version,
    );
  }

  /**
   * Called after a versionGuard()-gated statement affected zero rows.
   * Distinguishes "record doesn't exist" (StackNotFoundError) from "it
   * exists but isn't at expectedVersion" (StackVersionConflictError, with
   * the actual current version for the caller to act on).
   */
  private throwVersionConflict(id: string, expectedVersion: number | undefined): never {
    const row = this.exec.get<{ version: number }>('SELECT version FROM records WHERE id = ?', [
      id,
    ]);
    if (!row) throw new StackNotFoundError(`Record not found: "${id}"`);
    throw new StackVersionConflictError(
      `Record "${id}" is at version ${row.version}, expected ${expectedVersion}`,
      id,
      expectedVersion as number,
      row.version,
    );
  }

  // -------------------------------------------------------
  // Records
  // -------------------------------------------------------

  /**
   * A duplicate id hits the `records` PK — mapped to StackConflictError
   * instead of surfacing the raw engine exception, mirroring saveVersion's
   * collision mapping below.
   */
  async createRecord(record: StackRecord): Promise<StackRecord> {
    try {
      this.exec.run(
        `INSERT INTO records
          (id, type_id, created_at, updated_at, content, version,
           parent_id, entity_id, app_id, principal_id, updated_by, updated_via,
           deleted_at, unlisted_at, permissions)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          record.principalId ?? null,
          record.updatedBy ?? null,
          record.updatedVia ?? null,
          record.deletedAt ? toMs(record.deletedAt) : null,
          record.unlistedAt ? toMs(record.unlistedAt) : null,
          record.permissions ? JSON.stringify(record.permissions) : null,
        ],
      );
    } catch (err) {
      if (isUniqueConstraintViolation(err)) {
        throw new StackConflictError(`Record already exists: "${record.id}"`);
      }
      throw err;
    }

    if (record.associations?.length) {
      this.insertAssociations(record.id, record.associations);
    }

    fts5Strategy.insert(this.exec, record.id, JSON.stringify(record.content));
    this.syncFileRefs(record.id, record.typeId, record.content);
    return record;
  }

  async getRecord(id: string): Promise<StackRecord | null> {
    return this.readRecord(id);
  }

  /**
   * The synchronous read behind getRecord(). Callers inside exec.transaction()
   * use this one: an `await` inside that callback yields the microtask queue
   * mid-transaction, and the next operation to run would try to open one of
   * its own — transaction() requires a synchronous callback for exactly this
   * reason (see SqlExecutor.transaction).
   *
   * The same synchrony is what lets the post-commit reads below report the
   * version their own mutation produced: `getRecord()` runs its body before
   * the `await` yields, so nothing interleaves between the commit and the
   * read. A backend that made these reads genuinely asynchronous would open
   * that window, and a concurrent mutation could be reported under this
   * one's verb.
   */
  private readRecord(id: string): StackRecord | null {
    const row = this.exec.get<Record<string, unknown>>('SELECT * FROM records WHERE id = ?', [id]);
    if (!row) return null;
    const associations = this.getAssociationsForRecord(id);
    return rowToRecord(row, associations);
  }

  async patchContent(
    id: string,
    patch: Record<string, unknown | null>,
    opts: { expectedVersion?: number; snapshot?: RecordVersion } & ActorOptions = {},
  ): Promise<StackRecord> {
    const existing = await this.getRecord(id);
    if (!existing) throw new Error(`Record not found: "${id}"`);
    this.checkExpectedVersion(existing, opts.expectedVersion);

    const merged = applyMergePatch(existing.content, patch);
    this.exec.transaction(() => {
      if (opts.snapshot) this.snapshotBeforeMutation(id, opts.snapshot);
      fts5Strategy.remove(this.exec, id);
      this.exec.run(
        `UPDATE records SET content = ?, version = version + 1, updated_at = ?, updated_by = ?, updated_via = ? WHERE id = ?`,
        [
          JSON.stringify(merged),
          toMs(new Date()),
          opts.updatedBy ?? null,
          opts.updatedVia ?? null,
          id,
        ],
      );
      fts5Strategy.insert(this.exec, id, JSON.stringify(merged));
      this.syncFileRefs(id, existing.typeId, merged);
    });

    const updated = await this.getRecord(id);
    if (!updated) throw new Error(`Record not found after patchContent: "${id}"`);
    return updated;
  }

  async deleteRecord(
    id: string,
    opts: {
      hard?: boolean;
      expectedVersion?: number;
      snapshot?: RecordVersion;
    } & ActorOptions = {},
  ): Promise<StackRecord | null> {
    if (opts.hard) {
      return this.exec.transaction(() => this.hardDeleteRecord(id, opts.expectedVersion));
    } else {
      this.exec.transaction(() => {
        if (opts.snapshot) this.snapshotBeforeMutation(id, opts.snapshot);
        const { clause, params: verParams } = this.versionGuard(opts.expectedVersion);
        const changed = this.exec.run(
          `UPDATE records SET deleted_at = ?, version = version + 1, updated_at = ?, updated_by = ?, updated_via = ? WHERE id = ?${clause}`,
          [
            toMs(new Date()),
            toMs(new Date()),
            opts.updatedBy ?? null,
            opts.updatedVia ?? null,
            id,
            ...verParams,
          ],
        );
        if (changed === 0) this.throwVersionConflict(id, opts.expectedVersion);
      });
    }

    const updated = await this.getRecord(id);
    if (!updated) throw new Error(`Record not found after deleteRecord: "${id}"`);
    return updated;
  }

  /**
   * Deletes a record's FTS entry, associations, versions, file-refs, and
   * row, returning the record as it stood — the last copy that will ever
   * exist, read here so that nothing can overtake it between the read and
   * the deletes. Null when there was no such record. No write() call —
   * callers batch it. expectedVersion is checked first so a lost CAS race
   * leaves nothing touched (children reference the row, so the check can't
   * fold into the final DELETE).
   */
  private hardDeleteRecord(id: string, expectedVersion?: number): StackRecord | null {
    const purged = this.readRecord(id);
    if (expectedVersion !== undefined) {
      if (!purged) throw new StackNotFoundError(`Record not found: "${id}"`);
      if (purged.version !== expectedVersion) {
        throw new StackVersionConflictError(
          `Record "${id}" is at version ${purged.version}, expected ${expectedVersion}`,
          id,
          expectedVersion,
          purged.version,
        );
      }
    }
    if (!purged) return null;
    fts5Strategy.remove(this.exec, id);
    this.exec.run('DELETE FROM associations WHERE record_id = ?', [id]);
    this.exec.run('DELETE FROM versions WHERE record_id = ?', [id]);
    this.exec.run('DELETE FROM file_refs WHERE record_id = ?', [id]);
    this.exec.run('DELETE FROM records WHERE id = ?', [id]);
    return purged;
  }

  async undeleteRecord(
    id: string,
    opts: { expectedVersion?: number; snapshot?: RecordVersion } & ActorOptions = {},
  ): Promise<StackRecord> {
    this.exec.transaction(() => {
      if (opts.snapshot) this.snapshotBeforeMutation(id, opts.snapshot);
      const { clause, params: verParams } = this.versionGuard(opts.expectedVersion);
      const changed = this.exec.run(
        `UPDATE records SET deleted_at = NULL, version = version + 1, updated_at = ?, updated_by = ?, updated_via = ? WHERE id = ?${clause}`,
        [toMs(new Date()), opts.updatedBy ?? null, opts.updatedVia ?? null, id, ...verParams],
      );
      if (changed === 0) this.throwVersionConflict(id, opts.expectedVersion);
    });

    const updated = await this.getRecord(id);
    if (!updated) throw new Error(`Record not found after undelete: "${id}"`);
    return updated;
  }

  async setPermissions(
    id: string,
    permissions: Permission[],
    opts: { expectedVersion?: number; snapshot?: RecordVersion } & ActorOptions = {},
  ): Promise<StackRecord> {
    this.exec.transaction(() => {
      if (opts.snapshot) this.snapshotBeforeMutation(id, opts.snapshot);
      const { clause, params: verParams } = this.versionGuard(opts.expectedVersion);
      const changed = this.exec.run(
        `UPDATE records SET permissions = ?, version = version + 1, updated_at = ?, updated_by = ?, updated_via = ? WHERE id = ?${clause}`,
        [
          permissions.length ? JSON.stringify(permissions) : null,
          toMs(new Date()),
          opts.updatedBy ?? null,
          opts.updatedVia ?? null,
          id,
          ...verParams,
        ],
      );
      if (changed === 0) this.throwVersionConflict(id, opts.expectedVersion);
    });

    const updated = await this.getRecord(id);
    if (!updated) throw new Error(`Record not found after setPermissions: "${id}"`);
    return updated;
  }

  async setUnlisted(
    id: string,
    unlisted: boolean,
    opts: { expectedVersion?: number; snapshot?: RecordVersion } & ActorOptions = {},
  ): Promise<StackRecord> {
    this.exec.transaction(() => {
      if (opts.snapshot) this.snapshotBeforeMutation(id, opts.snapshot);
      const { clause, params: verParams } = this.versionGuard(opts.expectedVersion);
      const now = toMs(new Date());
      const changed = this.exec.run(
        `UPDATE records SET unlisted_at = ?, version = version + 1, updated_at = ?, updated_by = ?, updated_via = ? WHERE id = ?${clause}`,
        [
          unlisted ? now : null,
          now,
          opts.updatedBy ?? null,
          opts.updatedVia ?? null,
          id,
          ...verParams,
        ],
      );
      if (changed === 0) this.throwVersionConflict(id, opts.expectedVersion);
    });

    const updated = await this.getRecord(id);
    if (!updated) throw new Error(`Record not found after setUnlisted: "${id}"`);
    return updated;
  }

  async restoreVersion(
    id: string,
    version: number,
    opts: { expectedVersion?: number; snapshot?: RecordVersion } & ActorOptions = {},
  ): Promise<StackRecord> {
    const existing = await this.getRecord(id);
    if (!existing) throw new Error(`Record not found: "${id}"`);
    this.checkExpectedVersion(existing, opts.expectedVersion);

    const target = await this.getVersion(id, version);
    if (!target) throw new Error(`Version not found: ${id}@${version}`);

    this.exec.transaction(() => {
      if (opts.snapshot) this.snapshotBeforeMutation(id, opts.snapshot);
      fts5Strategy.remove(this.exec, id);
      this.exec.run(
        `UPDATE records SET type_id = ?, content = ?, version = version + 1, updated_at = ?, updated_by = ?, updated_via = ? WHERE id = ?`,
        [
          target.typeId,
          JSON.stringify(target.content),
          toMs(new Date()),
          opts.updatedBy ?? null,
          opts.updatedVia ?? null,
          id,
        ],
      );
      if (target.associations !== undefined) {
        this.exec.run('DELETE FROM associations WHERE record_id = ?', [id]);
        if (target.associations.length) this.insertAssociations(id, target.associations);
      }
      fts5Strategy.insert(this.exec, id, JSON.stringify(target.content));
      this.syncFileRefs(id, target.typeId, target.content);
    });

    const updated = await this.getRecord(id);
    if (!updated) throw new Error(`Record not found after restoreVersion: "${id}"`);
    return updated;
  }

  async commitMigration(
    id: string,
    toTypeId: TypeId,
    content: Record<string, unknown>,
    opts: { expectedVersion?: number; snapshot?: RecordVersion } & ActorOptions = {},
  ): Promise<StackRecord> {
    // Checked here rather than folded into the UPDATE's WHERE clause:
    // fts5Strategy.remove() has to run before the content changes, so the
    // precondition has to settle first — same shape as patchContent() and
    // restoreVersion().
    const existing = await this.getRecord(id);
    if (!existing) throw new Error(`Record not found: "${id}"`);
    this.checkExpectedVersion(existing, opts.expectedVersion);

    this.exec.transaction(() => {
      if (opts.snapshot) this.snapshotBeforeMutation(id, opts.snapshot);
      fts5Strategy.remove(this.exec, id);
      this.exec.run(
        `UPDATE records SET type_id = ?, content = ?, version = version + 1, updated_at = ?, updated_by = ?, updated_via = ? WHERE id = ?`,
        [
          toTypeId,
          JSON.stringify(content),
          toMs(new Date()),
          opts.updatedBy ?? null,
          opts.updatedVia ?? null,
          id,
        ],
      );
      fts5Strategy.insert(this.exec, id, JSON.stringify(content));
      this.syncFileRefs(id, toTypeId, content);
    });

    const updated = await this.getRecord(id);
    if (!updated) throw new Error(`Record not found after commitMigration: "${id}"`);
    return updated;
  }

  async queryRecords(query: StackQuery): Promise<QueryResult> {
    const { sql: where, params } = buildWhereClause(query);
    const order = buildOrderClause(query);
    const limit = query.limit ?? 50;

    // Fetch one extra to determine if there's a next page
    const rows = asStackQueryError(query, () =>
      this.exec.all<Record<string, unknown>>(
        `SELECT r.* FROM records r ${where} ${order} LIMIT ?`,
        [...params, limit + 1],
      ),
    );

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    const records = page.map((row) => {
      const associations = this.getAssociationsForRecord(row.id as string);
      return rowToRecord(row, associations);
    });

    const countRows = asStackQueryError(query, () =>
      this.exec.all<{ total: number }>(`SELECT COUNT(*) as total FROM records r ${where}`, params),
    );
    const total = countRows[0]?.total ?? 0;

    const lastRecord = records[records.length - 1];
    const cursor = hasMore && lastRecord ? makeCursor(lastRecord, getSortField(query)) : null;

    return { records, cursor, total };
  }

  /**
   * Atomically verify fileId is unreferenced, then hard-delete its
   * metadata records across every typeId in `metadataTypeIds` (see
   * deleteUnreferencedAttachmentRecords on the adapter contract). A real
   * SQL transaction of synchronous calls — no `await` between the check
   * and the deletes, so nothing interleaves.
   */
  async deleteUnreferencedAttachmentRecords(
    fileId: FileId,
    metadataTypeIds: TypeId[],
  ): Promise<StackRecord[]> {
    return this.exec.transaction(() => {
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

      // An empty family still owes the caller the reference check above —
      // the conflict is a fact about the file, not about which metadata
      // types happen to be defined.
      if (metadataTypeIds.length === 0) return [];

      const placeholders = metadataTypeIds.map(() => '?').join(', ');
      const metaRows = this.exec.all<{ id: string }>(
        `SELECT id FROM records
         WHERE type_id IN (${placeholders}) AND json_extract(content, '$.fileId') = ?`,
        [...metadataTypeIds, fileId],
      );
      const deleted: StackRecord[] = [];
      for (const row of metaRows) {
        const purged = this.hardDeleteRecord(row.id);
        if (purged) deleted.push(purged);
      }

      return deleted;
    });
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

  /**
   * A (record_id, version) collision is rejected loudly via the UNIQUE
   * constraint, mapped to StackConflictError — never a silently discarded
   * snapshot leaving a hole in rollback history. See
   * docs/spec/versioning.md § Optimistic concurrency (`ifVersion`).
   */
  private insertVersionRow(id: string, version: RecordVersion): void {
    try {
      this.exec.run(
        `INSERT INTO versions
          (record_id, version, type_id, content, updated_at, entity_id,
           updated_by, updated_via, associations, permissions)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          version.version,
          version.typeId,
          JSON.stringify(version.content),
          toMs(version.updatedAt),
          version.entityId ?? null,
          version.updatedBy ?? null,
          version.updatedVia ?? null,
          version.associations ? JSON.stringify(version.associations) : null,
          version.permissions ? JSON.stringify(version.permissions) : null,
        ],
      );
    } catch (err) {
      if (isUniqueConstraintViolation(err)) {
        throw new StackConflictError(
          `Version ${version.version} already exists for record "${id}" — a concurrent ` +
            `writer raced past this version. Use ifVersion to detect this before it happens.`,
        );
      }
      throw err;
    }
  }

  private overwriteVersionRow(id: string, version: RecordVersion): void {
    this.exec.run(
      `UPDATE versions
         SET type_id = ?, content = ?, updated_at = ?, entity_id = ?, associations = ?, permissions = ?
       WHERE record_id = ? AND version = ?`,
      [
        version.typeId,
        JSON.stringify(version.content),
        toMs(version.updatedAt),
        version.entityId ?? null,
        version.associations ? JSON.stringify(version.associations) : null,
        version.permissions ? JSON.stringify(version.permissions) : null,
        id,
        version.version,
      ],
    );
  }

  /**
   * Standalone snapshot write for tooling and tests — loud on any
   * collision, since nothing here is about to bump the version. Mutating
   * methods take a `snapshot` option instead; see snapshotBeforeMutation.
   */
  async saveVersion(id: string, version: RecordVersion): Promise<void> {
    this.insertVersionRow(id, version);
  }

  /**
   * The snapshot half of a mutating method's atomic snapshot-then-mutate
   * transaction. A collision is a racing-writer conflict, except an orphan
   * row at the record's *current* version — recognized by version number
   * alone, never content — which is overwritten so the interrupted write
   * can complete. See docs/spec/versioning.md § Snapshot atomicity.
   */
  private snapshotBeforeMutation(id: string, version: RecordVersion): void {
    try {
      this.insertVersionRow(id, version);
    } catch (err) {
      if (!(err instanceof StackConflictError)) throw err;

      const row = this.exec.get<{ version: number }>('SELECT version FROM records WHERE id = ?', [
        id,
      ]);
      if (!row || row.version !== version.version) throw err;

      this.overwriteVersionRow(id, version);
    }
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
    this.fileRefFieldsByType.set(
      type.id,
      fileRefFieldNames(type.schema as Record<string, { kind?: string }>),
    );
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

  async associate(
    recordId: string,
    association: Association,
    opts: { expectedVersion?: number; snapshot?: RecordVersion } & ActorOptions = {},
  ): Promise<StackRecord> {
    this.exec.transaction(() => {
      if (opts.snapshot) this.snapshotBeforeMutation(recordId, opts.snapshot);
      // Bump (and CAS-check) first, before the associations-table write, so
      // a lost race never partially applies.
      this.bumpVersion(recordId, opts);
      this.insertAssociations(recordId, [association]);
    });

    const updated = await this.getRecord(recordId);
    if (!updated) throw new Error(`Record not found after associate: "${recordId}"`);
    return updated;
  }

  async dissociate(
    recordId: string,
    association: Association,
    opts: { expectedVersion?: number; snapshot?: RecordVersion } & ActorOptions = {},
  ): Promise<StackRecord> {
    this.exec.transaction(() => {
      if (opts.snapshot) this.snapshotBeforeMutation(recordId, opts.snapshot);
      this.bumpVersion(recordId, opts);
      this.exec.run(
        `DELETE FROM associations
       WHERE record_id = ?
         AND kind = ?
         AND label = ?
         AND file_id       = ?
         AND related_scope = ?
         AND related_id    = ?
         AND related_ns    = ?
         AND related_stack = ?`,
        [recordId, association.kind, association.label, ...associationKeyColumns(association)],
      );
    });

    const updated = await this.getRecord(recordId);
    if (!updated) throw new Error(`Record not found after dissociate: "${recordId}"`);
    return updated;
  }

  private bumpVersion(id: string, opts: ExpectedVersionOptions & ActorOptions = {}): void {
    const { clause, params: verParams } = this.versionGuard(opts.expectedVersion);
    const changed = this.exec.run(
      `UPDATE records SET version = version + 1, updated_at = ?, updated_by = ?, updated_via = ? WHERE id = ?${clause}`,
      [toMs(new Date()), opts.updatedBy ?? null, opts.updatedVia ?? null, id, ...verParams],
    );
    if (changed === 0) this.throwVersionConflict(id, opts.expectedVersion);
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
            (record_id, kind, label, file_id, related_scope, related_id, related_ns, related_stack)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [recordId, assoc.kind, assoc.label, ...associationKeyColumns(assoc)],
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
   * File-ref field names for typeId, from the in-memory cache — falling
   * back to a `types` lookup (and populating the cache) only for a typeId
   * this process hasn't seen via saveType() yet, e.g. right after open().
   */
  private getFileRefFields(typeId: string): string[] {
    const cached = this.fileRefFieldsByType.get(typeId);
    if (cached) return cached;

    const typeRow = this.exec.get<{ schema: string }>('SELECT schema FROM types WHERE id = ?', [
      typeId,
    ]);
    const fields = typeRow
      ? fileRefFieldNames(JSON.parse(typeRow.schema) as Record<string, { kind?: string }>)
      : [];
    this.fileRefFieldsByType.set(typeId, fields);
    return fields;
  }

  /**
   * Replace a record's file_refs rows with whatever its content currently
   * holds in top-level file-ref fields, on every write that can change
   * content or typeId, so the index never drifts. Only top-level scalars
   * are indexed; the schema lookup is cached (fileRefFieldsByType).
   */
  private syncFileRefs(recordId: string, typeId: string, content: Record<string, unknown>): void {
    this.exec.run('DELETE FROM file_refs WHERE record_id = ?', [recordId]);

    const fields = this.getFileRefFields(typeId);
    for (const field of fields) {
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
