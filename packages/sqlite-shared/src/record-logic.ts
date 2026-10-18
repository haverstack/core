/**
 * The actual StackRecordAdapter logic (minus lifecycle: open/
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
  StackBadRequestError,
  applyMergePatch,
} from '@haverstack/core';
import type {
  RecordJournalEntry,
  JournalQuery,
  VersionsQuery,
  StackRecord,
  StackType,
  TypeId,
  FileId,
  RecordVersion,
  StackQuery,
  QueryResult,
  Association,
  AssociationEdit,
  AuthorityAssociation,
  DataAssociation,
  ActorOptions,
  IfVersionOptions,
} from '@haverstack/core';
import { RecordMovedError, sameAssociationSet } from '@haverstack/core/adapter';
import type {
  AspectWriteOptions,
  ElementWriteOptions,
  JournalEntryInput,
  JournalOptions,
  MutateOptions,
} from '@haverstack/core/adapter';
import type { SqlExecutor } from './executor.js';
import { isForeignKeyViolation, isUniqueConstraintViolation } from './executor.js';
import { buildQueryPlan, atBudget } from './query.js';
import { ContentIndex, SearchIndex } from './indexes.js';
import {
  rowToRecord,
  rowToAssociation,
  rowToPermission,
  permissionKeyColumns,
  rowToType,
  rowToVersion,
  rowToJournalEntry,
  toMs,
  associationKeyColumns,
} from './mappers.js';
import { makeCursor } from './cursor.js';

/**
 * Restate an engine parse error as `bad_request` when the query carries
 * search text, the one filter with a query language the sanitizer can't
 * fully repair. Any other clause is built from parameters, so a parse
 * error there is this module's bug and is rethrown untouched.
 */
const asStackBadRequestError = <T>(query: StackQuery, run: () => T): T => {
  try {
    return run();
  } catch (err) {
    if (!query.filter?.search) throw err;
    throw new StackBadRequestError(
      `Search text could not be parsed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
};

/**
 * One spelling of the optimistic-concurrency failure, so the message a
 * caller sees never depends on which check noticed it.
 */
const versionConflict = (id: string, expected: number, actual: number): StackVersionConflictError =>
  new StackVersionConflictError(
    `Record "${id}" is at version ${actual}, expected ${expected}`,
    id,
    expected,
    actual,
  );

const recordNotFound = (id: string): StackNotFoundError =>
  new StackNotFoundError(`Record not found: "${id}"`);

/**
 * Every `versions` column beyond the (record_id, version) key, and the
 * values for them in the same order — one list, so the INSERT that writes a
 * snapshot and the UPDATE that replaces one can't drift apart on which
 * columns a snapshot is made of.
 */
const VERSION_COLUMNS = [
  'type_id',
  'content',
  'updated_at',
  'entity_id',
  'principal_id',
  'updated_by',
  'updated_via',
] as const;

const versionRowValues = (version: RecordVersion): unknown[] => [
  version.typeId,
  JSON.stringify(version.content),
  toMs(version.updatedAt),
  version.createdBy?.subjectId ?? null,
  version.createdBy?.principalId ?? null,
  version.updatedBy?.subjectId ?? null,
  version.updatedBy?.principalId ?? null,
];

export type SharedSqlRecordLogicDeps = {
  exec: SqlExecutor;
};

export class SharedSqlRecordLogic {
  private readonly exec: SqlExecutor;
  private readonly searchIndex: SearchIndex;
  private readonly contentIndex: ContentIndex;

  constructor({ exec }: SharedSqlRecordLogicDeps) {
    this.exec = exec;
    this.searchIndex = new SearchIndex(exec);
    this.contentIndex = new ContentIndex(exec);
  }

  /** Check `ifVersion` against a version read inside the caller's transaction. */
  private checkExpectedVersion(id: string, actual: number, expected: number | undefined): void {
    if (expected === undefined || actual === expected) return;
    throw versionConflict(id, expected, actual);
  }

  /**
   * Called after a version-gated statement affected zero rows.
   * Distinguishes "record doesn't exist" (StackNotFoundError) from "it
   * exists but isn't at expectedVersion" (StackVersionConflictError, with
   * the actual current version for the caller to act on).
   */
  private throwVersionConflict(id: string, expectedVersion: number | undefined): never {
    const version = this.currentVersion(id);
    if (version === undefined) throw recordNotFound(id);
    throw versionConflict(id, expectedVersion as number, version);
  }

  /** The `expectLive` refusal, asked inside the write's transaction. */
  private checkLive(id: string, expectLive: boolean | undefined): void {
    if (!expectLive) return;
    const row = this.exec.get('SELECT 1 FROM records WHERE id = ? AND deleted_at IS NOT NULL', [
      id,
    ]);
    if (row) throw new RecordMovedError(id);
  }

  private currentVersion(id: string): number | undefined {
    return this.exec.get<{ version: number }>('SELECT version FROM records WHERE id = ?', [id])
      ?.version;
  }

  /**
   * What a mutation builds on, read inside its transaction so nothing can
   * land between the read and the write: a patch applied to an earlier read
   * would overwrite whatever changed since. Throws for a missing record or
   * a failed `ifVersion`.
   */
  private readForWrite(
    id: string,
    ifVersion: number | undefined,
  ): { typeId: TypeId; content: Record<string, unknown> } {
    const row = this.exec.get<{ version: number; type_id: string; content: string }>(
      'SELECT version, type_id, content FROM records WHERE id = ?',
      [id],
    );
    if (!row) throw recordNotFound(id);
    this.checkExpectedVersion(id, row.version, ifVersion);
    return { typeId: row.type_id, content: JSON.parse(row.content) };
  }

  /**
   * Every version-bumping UPDATE. The `ifVersion` guard rides in the WHERE
   * clause, so a write that reads nothing first (a soft delete, an
   * undelete) enforces it with no separate read.
   */
  private versionedUpdate(
    id: string,
    sets: string[],
    values: unknown[],
    opts: IfVersionOptions & ActorOptions,
    now = toMs(new Date()),
  ): void {
    const guarded = opts.ifVersion !== undefined;
    const changed = this.exec.run(
      `UPDATE records SET ${[...sets, 'version = version + 1', 'updated_at = ?', 'updated_by = ?', 'updated_via = ?'].join(', ')}` +
        ` WHERE id = ?${guarded ? ' AND version = ?' : ''}`,
      [
        ...values,
        now,
        opts.actor?.subjectId ?? null,
        opts.actor?.principalId ?? null,
        id,
        ...(guarded ? [opts.ifVersion] : []),
      ],
    );
    if (changed === 0) this.throwVersionConflict(id, opts.ifVersion);
  }

  /**
   * Read a record back after its own mutation committed. Absence here is an
   * invariant breach, not a "not found". Synchronous, so nothing can run
   * between the commit and the read — see readRecord().
   */
  private reread(id: string, verb: string): StackRecord {
    const updated = this.readRecord(id);
    if (!updated) throw new Error(`Record not found after ${verb}: "${id}"`);
    return updated;
  }

  // -------------------------------------------------------
  // Records
  // -------------------------------------------------------

  /**
   * One transaction, because a record and the tables that describe it are
   * one fact: a half-applied create raises, so the caller believes nothing
   * landed, while the surviving row fails their retry on the PK and is
   * missing from both indexes. A duplicate id maps to StackConflictError.
   */
  async createRecord(record: StackRecord, opts: JournalOptions = {}): Promise<StackRecord> {
    this.exec.transaction(() => {
      try {
        this.exec.run(
          `INSERT INTO records
          (id, type_id, created_at, updated_at, content, version,
           parent_id, entity_id, app_id, principal_id, updated_by, updated_via,
           deleted_at, unlisted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            record.id,
            record.typeId,
            toMs(record.createdAt),
            toMs(record.updatedAt),
            JSON.stringify(record.content),
            record.version,
            record.parentId ?? null,
            record.createdBy?.subjectId ?? null,
            record.appId ?? null,
            record.createdBy?.principalId ?? null,
            record.updatedBy?.subjectId ?? null,
            record.updatedBy?.principalId ?? null,
            record.deletedAt ? toMs(record.deletedAt) : null,
            record.unlistedAt ? toMs(record.unlistedAt) : null,
          ],
        );
      } catch (err) {
        if (isUniqueConstraintViolation(err)) {
          throw new StackConflictError(`Record already exists: "${record.id}"`);
        }
        throw err;
      }

      if (record.associations?.length) this.insertAssociations(record.id, record.associations);
      if (record.permissions?.length) this.insertPermissions(record.id, record.permissions);

      this.searchIndex.insert(record.id, JSON.stringify(record.content));
      this.contentIndex.sync(record.id, record.typeId, record.content);
      this.appendJournal(record.id, opts.journal);
    });

    return record;
  }

  async getRecord(id: string): Promise<StackRecord | null> {
    return this.readRecord(id);
  }

  /**
   * The synchronous read behind getRecord(), for use inside
   * exec.transaction(), whose callback can't await. reread() relies on the
   * same synchrony: nothing interleaves between a commit and its read, so a
   * concurrent mutation is never reported under this one's verb.
   */
  private readRecord(id: string): StackRecord | null {
    const row = this.exec.get<Record<string, unknown>>('SELECT * FROM records WHERE id = ?', [id]);
    return row ? this.hydrate([row])[0]! : null;
  }

  /**
   * Records rows with their associations and permissions attached: one
   * statement per element table for the whole list, so a page costs three
   * reads however many records it holds.
   */
  private hydrate(rows: Record<string, unknown>[]): StackRecord[] {
    const ids = JSON.stringify(rows.map((row) => row.id));
    const associations = this.elementsByRecord('associations', ids, rowToAssociation);
    const permissions = this.elementsByRecord('permissions', ids, rowToPermission);
    return rows.map((row) =>
      rowToRecord(
        row,
        associations.get(row.id as string) ?? [],
        permissions.get(row.id as string) ?? [],
      ),
    );
  }

  /**
   * The patch applies to the content as it stands when the write lands,
   * read inside the same transaction.
   */
  async patchContent(
    id: string,
    patch: Record<string, unknown | null>,
    opts: MutateOptions = {},
  ): Promise<StackRecord> {
    this.exec.transaction(() => {
      const current = this.readForWrite(id, opts.ifVersion);
      if (opts.snapshot) this.snapshotBeforeMutation(id, opts.snapshot);
      this.rewriteContent(id, current.typeId, applyMergePatch(current.content, patch), opts);
      this.appendJournal(id, opts.journal);
    });

    return this.reread(id, 'patchContent');
  }

  async setParent(
    id: string,
    parentId: string | null,
    opts: AspectWriteOptions = {},
  ): Promise<StackRecord> {
    return this.aspectUpdate(id, 'parent_id = ?', parentId, opts, 'setParent');
  }

  /** Stamped fresh: `Stack` hands this only a transition. */
  async setUnlisted(id: string, unlisted: boolean, opts: AspectWriteOptions = {}) {
    return this.aspectUpdate(
      id,
      'unlisted_at = ?',
      unlisted ? toMs(new Date()) : null,
      opts,
      'setUnlisted',
    );
  }

  /**
   * One records column that never bumps. The `ifVersion` guard rides in the
   * WHERE clause, as it does on a versioned update.
   */
  private aspectUpdate(
    id: string,
    set: string,
    value: unknown,
    opts: AspectWriteOptions,
    verb: string,
  ): StackRecord {
    const guarded = opts.ifVersion !== undefined;
    this.exec.transaction(() => {
      this.checkLive(id, opts.expectLive);
      const changed = this.exec.run(
        `UPDATE records SET ${set} WHERE id = ?${guarded ? ' AND version = ?' : ''}`,
        [value, id, ...(guarded ? [opts.ifVersion] : [])],
      );
      if (changed === 0) this.throwVersionConflict(id, opts.ifVersion);
      this.appendJournal(id, opts.journal);
    });
    return this.reread(id, verb);
  }

  async deleteRecord(
    id: string,
    opts: { purge?: boolean } & MutateOptions = {},
  ): Promise<StackRecord | null> {
    if (opts.purge) {
      return this.exec.transaction(() => this.purgeRecord(id, opts.ifVersion));
    }

    // One timestamp for both columns: a soft delete is a single event, and
    // two `new Date()` calls can straddle a millisecond boundary and leave
    // deleted_at and updated_at disagreeing about when it happened.
    const now = toMs(new Date());
    this.exec.transaction(() => {
      if (opts.snapshot) this.snapshotBeforeMutation(id, opts.snapshot);
      this.versionedUpdate(id, ['deleted_at = ?'], [now], opts, now);
      this.appendJournal(id, opts.journal);
    });

    return this.reread(id, 'deleteRecord');
  }

  /**
   * Delete a record and everything that refers to it, returning the record
   * as it stood (null if there was none). Read here, inside the caller's
   * transaction, so nothing can overtake the last copy that will ever exist.
   */
  private purgeRecord(id: string, ifVersion?: number): StackRecord | null {
    const purged = this.readRecord(id);
    if (!purged) {
      // A CAS against a record that isn't there is a failed precondition,
      // not the "nothing to delete" that an unconditional purge
      // reports by returning null.
      if (ifVersion !== undefined) throw recordNotFound(id);
      return null;
    }
    this.checkExpectedVersion(id, purged.version, ifVersion);
    this.searchIndex.remove(id);
    this.exec.run('DELETE FROM associations WHERE record_id = ?', [id]);
    this.exec.run('DELETE FROM permissions WHERE record_id = ?', [id]);
    this.exec.run('DELETE FROM versions WHERE record_id = ?', [id]);
    // A purge takes the journal with it, for the reason it takes the
    // version history: a log naming what a destroyed record once held is
    // exactly the residue this verb exists to leave nothing of.
    this.exec.run('DELETE FROM journal WHERE record_id = ?', [id]);
    this.contentIndex.remove(id);
    this.exec.run('DELETE FROM records WHERE id = ?', [id]);
    return purged;
  }

  async undeleteRecord(id: string, opts: MutateOptions = {}): Promise<StackRecord> {
    this.exec.transaction(() => {
      if (opts.snapshot) this.snapshotBeforeMutation(id, opts.snapshot);
      this.versionedUpdate(id, ['deleted_at = NULL'], [], opts);
      this.appendJournal(id, opts.journal);
    });

    return this.reread(id, 'undelete');
  }

  async restoreVersion(
    id: string,
    version: number,
    opts: MutateOptions = {},
  ): Promise<StackRecord> {
    // Only content and its type are restored — a snapshot carries nothing
    // else, so there is nothing here to roll containment, listing or the
    // associations table back to.
    this.exec.transaction(() => {
      this.readForWrite(id, opts.ifVersion);
      const target = this.readVersion(id, version);
      if (!target) throw new StackNotFoundError(`Version not found: "${id}"@${version}`);
      if (opts.snapshot) this.snapshotBeforeMutation(id, opts.snapshot);
      this.rewriteContent(id, target.typeId, target.content, opts);
      this.appendJournal(id, opts.journal);
    });

    return this.reread(id, 'restoreVersion');
  }

  async commitMigration(
    id: string,
    toTypeId: TypeId,
    content: Record<string, unknown>,
    opts: MutateOptions = {},
  ): Promise<StackRecord> {
    this.exec.transaction(() => {
      this.readForWrite(id, opts.ifVersion);
      if (opts.snapshot) this.snapshotBeforeMutation(id, opts.snapshot);
      this.rewriteContent(id, toTypeId, content, opts);
      this.appendJournal(id, opts.journal);
    });

    return this.reread(id, 'commitMigration');
  }

  /**
   * Replace a record's type and content wholesale. Unindex, write, re-index,
   * in that order (docs/spec/adapters.md § The search index is unindexed
   * before the row moves); callers must be inside exec.transaction().
   */
  private rewriteContent(
    id: string,
    typeId: TypeId,
    content: Record<string, unknown>,
    opts: IfVersionOptions & ActorOptions,
  ): void {
    const json = JSON.stringify(content);
    this.searchIndex.remove(id);
    this.versionedUpdate(id, ['type_id = ?', 'content = ?'], [typeId, json], opts);
    this.searchIndex.insert(id, json);
    this.contentIndex.sync(id, typeId, content);
  }

  async queryRecords(query: StackQuery): Promise<QueryResult> {
    const limit = query.limit ?? 50;
    // One extra row, to learn whether a further page follows.
    const fetch = limit + 1;

    // A content-field sort is two statements (see buildQueryPlan). Each asks
    // only for what the page still lacks, so the second usually never runs.
    const rows: Record<string, unknown>[] = [];
    for (const page of buildQueryPlan(query)) {
      const budget = fetch - rows.length;
      if (budget <= 0) break;
      const statement = atBudget(page, budget);
      rows.push(
        ...asStackBadRequestError(query, () =>
          this.exec.all<Record<string, unknown>>(statement.sql, statement.params),
        ),
      );
    }

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    const records = this.hydrate(page);

    const lastRecord = records[records.length - 1];
    const cursor =
      hasMore && lastRecord
        ? makeCursor(lastRecord, query.sort, (record, field) =>
            this.contentIndex.kindOf(record.typeId, field),
          )
        : null;

    return { records, cursor };
  }

  /**
   * The reference check and the purges share one synchronous transaction,
   * so nothing can add a reference between the two.
   */
  async deleteUnreferencedAttachmentRecords(
    fileId: FileId,
    metadataTypeIds: TypeId[],
  ): Promise<StackRecord[]> {
    return this.exec.transaction(() => {
      const referenced = this.exec.all<{ found: number }>(
        `SELECT 1 as found FROM associations WHERE kind = 'attachment' AND file_id = ?
         UNION ALL
         SELECT 1 FROM content_index WHERE file_id = ?
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
        const purged = this.purgeRecord(row.id);
        if (purged) deleted.push(purged);
      }

      return deleted;
    });
  }

  // -------------------------------------------------------
  // Versions
  // -------------------------------------------------------

  async getVersions(id: string, query: VersionsQuery = {}): Promise<RecordVersion[]> {
    const conditions = ['record_id = ?'];
    const values: unknown[] = [id];
    if (query.beforeVersion !== undefined) {
      conditions.push('version < ?');
      values.push(query.beforeVersion);
    }
    const rows = this.exec.all<Record<string, unknown>>(
      `SELECT * FROM versions WHERE ${conditions.join(' AND ')} ORDER BY version DESC${
        query.limit !== undefined ? ' LIMIT ?' : ''
      }`,
      query.limit !== undefined ? [...values, query.limit] : values,
    );
    return rows.map(rowToVersion);
  }

  async getVersion(id: string, version: number): Promise<RecordVersion | null> {
    return this.readVersion(id, version);
  }

  private readVersion(id: string, version: number): RecordVersion | null {
    const row = this.exec.get<Record<string, unknown>>(
      'SELECT * FROM versions WHERE record_id = ? AND version = ?',
      [id, version],
    );
    return row ? rowToVersion(row) : null;
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
          (record_id, version, ${VERSION_COLUMNS.join(', ')})
         VALUES (?, ?, ${VERSION_COLUMNS.map(() => '?').join(', ')})`,
        [id, version.version, ...versionRowValues(version)],
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

  /**
   * Replaces every column insertVersionRow writes — structurally, off the
   * same VERSION_COLUMNS list, because a column left out here would keep
   * the replaced row's value and surface later as a restore putting back
   * something the snapshot never said.
   */
  private overwriteVersionRow(id: string, version: RecordVersion): void {
    this.exec.run(
      `UPDATE versions
         SET ${VERSION_COLUMNS.map((c) => `${c} = ?`).join(', ')}
       WHERE record_id = ? AND version = ?`,
      [...versionRowValues(version), id, version.version],
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

      if (this.currentVersion(id) !== version.version) throw err;

      this.overwriteVersionRow(id, version);
    }
  }

  // -------------------------------------------------------
  // Change journal
  // -------------------------------------------------------

  /**
   * Append one entry, stamped from the row as it now stands, so callers run
   * this inside their write's transaction, after the write. `seq` is
   * allocated in the INSERT itself, so no caller ever holds one it expects
   * to be free. See docs/spec/journal.md § Ordering.
   */
  private appendJournal(recordId: string, entry: JournalEntryInput | undefined): void {
    if (!entry) return;
    // Not readRecord(): this runs on every write and needs three columns,
    // not the row plus its associations. parent_id stays raw so its
    // NULL/''/id spelling reaches the journal unchanged.
    const row = this.exec.get<{
      version: number;
      type_id: string;
      parent_id: string | null;
    }>('SELECT version, type_id, parent_id FROM records WHERE id = ?', [recordId]);
    if (!row) throw recordNotFound(recordId);

    this.exec.run(
      `INSERT INTO journal
        (record_id, seq, at, kind, ops, version, type_id, parent_id,
         previous_parent_id, actor, associations)
       VALUES (
         ?,
         (SELECT COALESCE(MAX(seq), 0) + 1 FROM journal WHERE record_id = ?),
         ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        recordId,
        recordId,
        toMs(new Date()),
        entry.kind,
        JSON.stringify(entry.ops),
        row.version,
        row.type_id,
        row.parent_id,
        // '' is the root; NULL is an entry that names no origin at all.
        entry.previousParentId === undefined ? null : (entry.previousParentId ?? ''),
        entry.actor ? JSON.stringify(entry.actor) : null,
        entry.associations?.length ? JSON.stringify(entry.associations) : null,
      ],
    );
  }

  async getJournal(id: string, query: JournalQuery = {}): Promise<RecordJournalEntry[]> {
    // An empty log means "nothing changed" unconditionally, so a record
    // that isn't there cannot be spelled that way. A purged record is gone,
    // and gets the same refusal. See docs/spec/journal.md § Reading it.
    if (!this.exec.get('SELECT 1 FROM records WHERE id = ?', [id])) {
      throw recordNotFound(id);
    }
    const conditions = ['record_id = ?'];
    const values: unknown[] = [id];
    if (query.afterSeq !== undefined) {
      conditions.push('seq > ?');
      values.push(query.afterSeq);
    }
    const rows = this.exec.all<Record<string, unknown>>(
      `SELECT * FROM journal WHERE ${conditions.join(' AND ')} ORDER BY seq ASC${
        query.limit !== undefined ? ' LIMIT ?' : ''
      }`,
      query.limit !== undefined ? [...values, query.limit] : values,
    );
    return rows.map(rowToJournalEntry);
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
    this.contentIndex.rememberType(type);
  }

  async getType(id: TypeId): Promise<StackType | null> {
    const row = this.exec.get<Record<string, unknown>>('SELECT * FROM types WHERE id = ?', [id]);
    return row ? rowToType(row) : null;
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

  /**
   * A write to one of a record's two element tables, inside a transaction
   * that first checks the record exists, is live under `expectLive`, is at
   * `ifVersion`, and that the table holds `expectSet`. Never bumps and never snapshots.
   */
  private elementWrite(
    id: string,
    table: 'associations' | 'permissions',
    opts: ElementWriteOptions<Association>,
    write: () => void,
    verb: string,
  ): StackRecord {
    this.exec.transaction(() => {
      const version = this.currentVersion(id);
      if (version === undefined) throw recordNotFound(id);
      this.checkLive(id, opts.expectLive);
      this.checkExpectedVersion(id, version, opts.ifVersion);
      if (opts.expectSet) {
        const ids = JSON.stringify([id]);
        const map = table === 'associations' ? rowToAssociation : rowToPermission;
        const stored = this.elementsByRecord<Association>(table, ids, map).get(id) ?? [];
        if (!sameAssociationSet(stored, opts.expectSet)) throw new RecordMovedError(id);
      }
      write();
      this.appendJournal(id, opts.journal);
    });
    return this.reread(id, verb);
  }

  async editAssociations(
    id: string,
    edits: AssociationEdit[],
    opts: ElementWriteOptions<DataAssociation> = {},
  ): Promise<StackRecord> {
    return this.elementWrite(
      id,
      'associations',
      opts,
      () => {
        for (const edit of edits) {
          if (edit.op !== 'remove') continue;
          const association = edit.association as DataAssociation;
          this.exec.run(
            `DELETE FROM associations
             WHERE record_id = ? AND kind = ? AND label = ?
               AND file_id = ? AND related_scope = ? AND related_id = ?
               AND related_ns = ? AND related_stack = ?`,
            [id, association.kind, association.label, ...associationKeyColumns(association)],
          );
        }
        this.insertAssociations(id, addsOf(edits) as DataAssociation[]);
      },
      'editAssociations',
    );
  }

  async setAssociations(
    id: string,
    associations: DataAssociation[],
    opts: ElementWriteOptions<DataAssociation> = {},
  ): Promise<StackRecord> {
    return this.elementWrite(
      id,
      'associations',
      opts,
      () => {
        this.exec.run('DELETE FROM associations WHERE record_id = ?', [id]);
        this.insertAssociations(id, associations);
      },
      'setAssociations',
    );
  }

  /** editAssociations() over the permissions table. */
  async editAccess(
    id: string,
    edits: AssociationEdit[],
    opts: ElementWriteOptions<AuthorityAssociation> = {},
  ): Promise<StackRecord> {
    return this.elementWrite(
      id,
      'permissions',
      opts,
      () => {
        for (const edit of edits) {
          if (edit.op !== 'remove') continue;
          const permission = edit.association as AuthorityAssociation;
          this.exec.run(
            `DELETE FROM permissions
             WHERE record_id = ? AND kind = ? AND label = ?
               AND grantee_kind = ? AND grantee_id = ? AND role = ?`,
            [id, permission.kind, permission.label, ...permissionKeyColumns(permission)],
          );
        }
        this.insertPermissions(id, addsOf(edits) as AuthorityAssociation[]);
      },
      'editAccess',
    );
  }

  async setAccess(
    id: string,
    permissions: AuthorityAssociation[],
    opts: ElementWriteOptions<AuthorityAssociation> = {},
  ): Promise<StackRecord> {
    return this.elementWrite(
      id,
      'permissions',
      opts,
      () => {
        this.exec.run('DELETE FROM permissions WHERE record_id = ?', [id]);
        this.insertPermissions(id, permissions);
      },
      'setAccess',
    );
  }

  /**
   * Upserts on association identity, so re-pointing `attachment_record_id`
   * (outside the key) costs no second row. A missing record trips the
   * foreign key, reported as StackNotFoundError rather than an orphan row.
   */
  private insertAssociations(recordId: string, associations: DataAssociation[]): void {
    for (const assoc of associations) {
      this.insertRow(recordId, () =>
        this.exec.run(
          `INSERT INTO associations
            (record_id, kind, label, file_id, related_scope, related_id, related_ns,
             related_stack, attachment_record_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT DO UPDATE SET attachment_record_id = excluded.attachment_record_id`,
          [
            recordId,
            assoc.kind,
            assoc.label,
            ...associationKeyColumns(assoc),
            assoc.kind === 'attachment' ? (assoc.attachmentRecordId ?? '') : '',
          ],
        ),
      );
    }
  }

  /** Every column is in the key, so a repeated element is the same row. */
  private insertPermissions(recordId: string, permissions: AuthorityAssociation[]): void {
    for (const p of permissions) {
      this.insertRow(recordId, () =>
        this.exec.run(
          `INSERT INTO permissions (record_id, kind, label, grantee_kind, grantee_id, role)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT DO NOTHING`,
          [recordId, p.kind, p.label, ...permissionKeyColumns(p)],
        ),
      );
    }
  }

  private insertRow(recordId: string, insert: () => void): void {
    try {
      insert();
    } catch (err) {
      if (isForeignKeyViolation(err)) throw recordNotFound(recordId);
      throw err;
    }
  }

  /**
   * One element table's rows for every record in `ids` (a JSON array), in
   * primary-key order — the order a single record's read has always had.
   */
  private elementsByRecord<T>(
    table: 'associations' | 'permissions',
    ids: string,
    map: (row: Record<string, unknown>) => T,
  ): Map<string, T[]> {
    const byRecord = new Map<string, T[]>();
    const rows = this.exec.all<Record<string, unknown>>(
      `SELECT * FROM ${table} WHERE record_id IN (SELECT value FROM json_each(?))
       ORDER BY ${table === 'associations' ? ASSOCIATION_KEY : PERMISSION_KEY}`,
      [ids],
    );
    for (const row of rows) {
      const id = row.record_id as string;
      const list = byRecord.get(id);
      if (list) list.push(map(row));
      else byRecord.set(id, [map(row)]);
    }
    return byRecord;
  }
}

/** Each element table's primary key, so a batched read keeps one record's own order. */
const ASSOCIATION_KEY =
  'record_id, kind, label, file_id, related_scope, related_id, related_ns, related_stack';
const PERMISSION_KEY = 'record_id, kind, label, grantee_kind, grantee_id, role';

const addsOf = (edits: readonly AssociationEdit[]) =>
  edits.flatMap((e) => (e.op === 'add' ? [e.association] : []));
