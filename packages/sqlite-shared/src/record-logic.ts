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
  RecordJournalEntry,
  JournalQuery,
  StackRecord,
  StackType,
  TypeId,
  FileId,
  RecordVersion,
  RecordChanges,
  StackQuery,
  QueryResult,
  Association,
  ActorOptions,
} from '@haverstack/core';
import type {
  JournalEntryInput,
  JournalOptions,
  ExpectedVersionOptions,
} from '@haverstack/core/adapter';
import type { SqlExecutor } from './executor.js';
import { isForeignKeyViolation, isUniqueConstraintViolation } from './executor.js';
import { buildQueryPlan, atBudget } from './query.js';
import { fts5Strategy } from './fts5.js';
import {
  rowToRecord,
  rowToAssociation,
  rowToType,
  rowToVersion,
  rowToJournalEntry,
  toMs,
  associationKeyColumns,
} from './mappers.js';
import { makeCursor } from './cursor.js';
import { contentSortEntry } from '@haverstack/core/adapter';
import type { ScalarFieldKind } from '@haverstack/core';

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

/**
 * One spelling of the optimistic-concurrency failure, so the message a
 * caller sees never depends on which of the three places noticed it.
 */
const versionConflict = (id: string, expected: number, actual: number): StackVersionConflictError =>
  new StackVersionConflictError(
    `Record "${id}" is at version ${actual}, expected ${expected}`,
    id,
    expected,
    actual,
  );

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

/**
 * Top-level scalar fields, by name and declared kind — what content_index
 * covers. Arrays and objects are left out: a value inside one has no
 * single position to order its record by, and no file reference the
 * attachment filter can see.
 */
const indexedFieldKinds = (
  schema: Record<string, { kind?: string }>,
): Map<string, ScalarFieldKind> => {
  const kinds = new Map<string, ScalarFieldKind>();
  for (const [field, def] of Object.entries(schema)) {
    if (!def.kind || def.kind === 'array' || def.kind === 'object') continue;
    kinds.set(field, def.kind as ScalarFieldKind);
  }
  return kinds;
};

export class SharedSqlRecordLogic {
  /**
   * Per-typeId cache of the fields content_index covers and their declared
   * kinds, so syncContentIndex() doesn't hit the `types` table and
   * re-parse schema JSON on every write. Populated eagerly in saveType()
   * and lazily via getIndexedFields().
   */
  private readonly indexedFieldsByType = new Map<string, Map<string, ScalarFieldKind>>();

  constructor(private readonly deps: SharedSqlRecordLogicDeps) {}

  private get exec(): SqlExecutor {
    return this.deps.exec;
  }

  /**
   * Precondition check for a mutation that has already read the record —
   * either because it can't fold the check into its own statement
   * (hardDeleteRecord: children reference the row, so the DELETE can't
   * carry it), or because it has to settle the precondition *before*
   * fts5Strategy.remove() runs, which needs the records row still holding
   * the old content. In the latter case versionedUpdate() re-checks it
   * inside the statement, and that is the enforcement; this is what lets
   * the work before it be skipped.
   */
  private checkExpectedVersion(record: StackRecord, expectedVersion: number | undefined): void {
    if (expectedVersion === undefined || record.version === expectedVersion) return;
    throw versionConflict(record.id, expectedVersion, record.version);
  }

  /**
   * Called after a version-gated statement affected zero rows.
   * Distinguishes "record doesn't exist" (StackNotFoundError) from "it
   * exists but isn't at expectedVersion" (StackVersionConflictError, with
   * the actual current version for the caller to act on).
   */
  private throwVersionConflict(id: string, expectedVersion: number | undefined): never {
    const row = this.exec.get<{ version: number }>('SELECT version FROM records WHERE id = ?', [
      id,
    ]);
    if (!row) throw new StackNotFoundError(`Record not found: "${id}"`);
    throw versionConflict(id, expectedVersion as number, row.version);
  }

  /**
   * The one shape every mutating UPDATE in this class has: whatever columns
   * the caller is changing, then the version bump and the actor/timestamp
   * stamp that every mutation owes, gated on the opt-in `expectedVersion`
   * precondition and failing loudly when nothing matched.
   *
   * The guard rides in the WHERE clause even where the caller has already
   * checked the version against a record it read: that read is outside this
   * statement, so a writer slipping in between the two is caught here
   * rather than silently overwritten.
   */
  private versionedUpdate(
    id: string,
    sets: string[],
    values: unknown[],
    opts: ExpectedVersionOptions & ActorOptions,
    now = toMs(new Date()),
  ): void {
    const guarded = opts.expectedVersion !== undefined;
    const changed = this.exec.run(
      `UPDATE records SET ${[...sets, 'version = version + 1', 'updated_at = ?', 'updated_by = ?', 'updated_via = ?'].join(', ')}` +
        ` WHERE id = ?${guarded ? ' AND version = ?' : ''}`,
      [
        ...values,
        now,
        opts.actor?.subjectId ?? null,
        opts.actor?.principalId ?? null,
        id,
        ...(guarded ? [opts.expectedVersion] : []),
      ],
    );
    if (changed === 0) this.throwVersionConflict(id, opts.expectedVersion);
  }

  /**
   * Read a record back after its own mutation committed, for the caller to
   * return. Its absence is not a "not found" for the caller to handle — the
   * mutation just succeeded against it — so it fails as the invariant
   * breach it would be.
   *
   * Synchronous, via readRecord() rather than getRecord(), so the read
   * cannot be separated from the commit by anything: an async caller
   * returning this still hands back a record read in the same tick its
   * transaction committed. See readRecord() for why that matters.
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
   * A duplicate id hits the `records` PK — mapped to StackConflictError
   * instead of surfacing the raw engine exception, mirroring saveVersion's
   * collision mapping below.
   *
   * One transaction, because a record and the four tables that describe it
   * are one fact. A half-applied create is worse than a failed one: the
   * call raises, so the caller believes nothing landed, while the records
   * row survives to fail their retry on the PK — and the row it leaves is
   * invisible to `filter.search` and mis-ordered by `sort.contentField`
   * until something writes it again.
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

      const edges = [...(record.associations ?? []), ...(record.permissions ?? [])];
      if (edges.length) this.insertAssociations(record.id, edges);

      fts5Strategy.insert(this.exec, record.id, JSON.stringify(record.content));
      this.syncContentIndex(record.id, record.typeId, record.content);
      this.appendJournal(record.id, opts.journal);
    });

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
   * version their own mutation produced: reread() calls this directly, so
   * nothing interleaves between the commit and the read even though the
   * method returning it is async. A backend that made these reads genuinely
   * asynchronous would open that window, and a concurrent mutation could be
   * reported under this one's verb.
   */
  private readRecord(id: string): StackRecord | null {
    const row = this.exec.get<Record<string, unknown>>('SELECT * FROM records WHERE id = ?', [id]);
    if (!row) return null;
    const associations = this.getAssociationsForRecord(id);
    return rowToRecord(row, associations);
  }

  /**
   * Apply a change set in one transaction: one UPDATE over the record row
   * with only the columns the change set names, the association set
   * replaced when it carries one, and the snapshot written alongside — so
   * one call is one version whatever it moved.
   *
   * `opts.bumpsVersion: false` is a change set that touches only
   * `associations`, `parentId` and/or `unlisted` — Stack computes this from
   * which ops the set actually moves. Such a write still lands its columns,
   * but leaves `version`, `updatedAt` and the actor stamps exactly as they
   * stood and takes no snapshot. `expectedVersion`, if given, is re-checked
   * synchronously inside the transaction — the CAS guard the bumping path
   * gets from its UPDATE's WHERE clause, restated as a read because the
   * UPDATE here carries no version predicate. See
   * docs/spec/versioning.md § Version history.
   *
   * The expectedVersion check for a bumping write is standalone rather than
   * folded into the UPDATE alone, because a content change needs
   * fts.remove() to run *before* the records-table content changes. The
   * guard is still in the UPDATE's WHERE, so a writer that slipped in
   * between the read and the write is caught there rather than overwriting.
   */
  async mutateRecord(
    id: string,
    changes: RecordChanges,
    opts: {
      expectedVersion?: number;
      snapshot?: RecordVersion;
      bumpsVersion?: boolean;
    } & ActorOptions &
      JournalOptions = {},
  ): Promise<StackRecord> {
    const existing = await this.getRecord(id);
    if (!existing) throw new StackNotFoundError(`Record not found: "${id}"`);
    this.checkExpectedVersion(existing, opts.expectedVersion);

    const now = toMs(new Date());

    // Assembled rather than written out per aspect: every aspect is the
    // same column-and-value pair on one row, and a fixed statement per
    // combination would be 2^4 of them. Built before the no-bump branch
    // because both paths write the same columns; only `content` is the
    // bumping path's alone, since a patch always bumps.
    const sets: string[] = [];
    const values: unknown[] = [];
    if (changes.parentId !== undefined) {
      sets.push('parent_id = ?');
      values.push(changes.parentId);
    }
    if (changes.unlisted !== undefined) {
      sets.push('unlisted_at = ?');
      // Stamped fresh because this key is only ever present on a
      // transition — Stack narrows a change set to the aspects that
      // actually moved before it reaches an adapter.
      values.push(changes.unlisted ? now : null);
    }

    if (opts.bumpsVersion === false) {
      this.exec.transaction(() => {
        const current = this.readRecord(id);
        if (!current) throw new StackNotFoundError(`Record not found: "${id}"`);
        this.checkExpectedVersion(current, opts.expectedVersion);
        if (sets.length > 0) {
          this.exec.run(`UPDATE records SET ${sets.join(', ')} WHERE id = ?`, [...values, id]);
        }
        this.replaceAssociationHalves(id, changes);
        this.appendJournal(id, opts.journal);
      });
      return this.reread(id, 'mutateRecord');
    }

    const merged = changes.contentPatch
      ? applyMergePatch(existing.content, changes.contentPatch)
      : undefined;
    if (merged !== undefined) {
      sets.unshift('content = ?');
      values.unshift(JSON.stringify(merged));
    }

    this.exec.transaction(() => {
      if (opts.snapshot) this.snapshotBeforeMutation(id, opts.snapshot);
      if (merged !== undefined) fts5Strategy.remove(this.exec, id);

      this.versionedUpdate(id, sets, values, opts, now);

      this.replaceAssociationHalves(id, changes);

      if (merged !== undefined) {
        fts5Strategy.insert(this.exec, id, JSON.stringify(merged));
        this.syncContentIndex(id, existing.typeId, merged);
      }
      this.appendJournal(id, opts.journal);
    });

    return this.reread(id, 'mutateRecord');
  }

  async deleteRecord(
    id: string,
    opts: {
      hard?: boolean;
      expectedVersion?: number;
      snapshot?: RecordVersion;
    } & ActorOptions &
      JournalOptions = {},
  ): Promise<StackRecord | null> {
    if (opts.hard) {
      return this.exec.transaction(() => this.hardDeleteRecord(id, opts.expectedVersion));
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
   * Deletes a record's FTS entry, associations, versions, file-refs, sort
   * index rows, and row, returning the record as it stood — the last copy that will ever
   * exist, read here so that nothing can overtake it between the read and
   * the deletes. Null when there was no such record. No write() call —
   * callers batch it. expectedVersion is checked first so a lost CAS race
   * leaves nothing touched (children reference the row, so the check can't
   * fold into the final DELETE).
   */
  private hardDeleteRecord(id: string, expectedVersion?: number): StackRecord | null {
    const purged = this.readRecord(id);
    if (!purged) {
      // A CAS against a record that isn't there is a failed precondition,
      // not the "nothing to delete" that an unconditional hard delete
      // reports by returning null.
      if (expectedVersion !== undefined) throw new StackNotFoundError(`Record not found: "${id}"`);
      return null;
    }
    this.checkExpectedVersion(purged, expectedVersion);
    fts5Strategy.remove(this.exec, id);
    this.exec.run('DELETE FROM associations WHERE record_id = ?', [id]);
    this.exec.run('DELETE FROM versions WHERE record_id = ?', [id]);
    // A purge takes the journal with it, for the reason it takes the
    // version history: a log naming what a destroyed record once held is
    // exactly the residue this verb exists to leave nothing of.
    this.exec.run('DELETE FROM journal WHERE record_id = ?', [id]);
    this.exec.run('DELETE FROM content_index WHERE record_id = ?', [id]);
    this.exec.run('DELETE FROM records WHERE id = ?', [id]);
    return purged;
  }

  async undeleteRecord(
    id: string,
    opts: { expectedVersion?: number; snapshot?: RecordVersion } & ActorOptions &
      JournalOptions = {},
  ): Promise<StackRecord> {
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
    opts: {
      expectedVersion?: number;
      snapshot?: RecordVersion;
    } & ActorOptions &
      JournalOptions = {},
  ): Promise<StackRecord> {
    const existing = await this.getRecord(id);
    if (!existing) throw new StackNotFoundError(`Record not found: "${id}"`);
    this.checkExpectedVersion(existing, opts.expectedVersion);

    const target = await this.getVersion(id, version);
    if (!target) throw new StackNotFoundError(`Version not found: "${id}"@${version}`);

    // Only content and its type are restored — a snapshot carries nothing
    // else, so there is nothing here to roll containment, listing or the
    // associations table back to.
    this.exec.transaction(() => {
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
    opts: { expectedVersion?: number; snapshot?: RecordVersion } & ActorOptions &
      JournalOptions = {},
  ): Promise<StackRecord> {
    // Checked against a read record first, rather than left to the
    // UPDATE's WHERE clause alone: fts5Strategy.remove() has to run before
    // the content changes, so the precondition has to settle before that
    // work starts. rewriteContent()'s UPDATE still carries the guard, so a
    // writer slipping in between the two is caught rather than overwritten
    // — same shape as mutateRecord() and restoreVersion().
    const existing = await this.getRecord(id);
    if (!existing) throw new StackNotFoundError(`Record not found: "${id}"`);
    this.checkExpectedVersion(existing, opts.expectedVersion);

    this.exec.transaction(() => {
      if (opts.snapshot) this.snapshotBeforeMutation(id, opts.snapshot);
      this.rewriteContent(id, toTypeId, content, opts);
      this.appendJournal(id, opts.journal);
    });

    return this.reread(id, 'commitMigration');
  }

  /**
   * Replace a record's type and content wholesale — what restoreVersion and
   * commitMigration each do, differing only in where the content came from.
   *
   * The order is the constraint: fts5Strategy.remove() has to read the old
   * content off the records row, so it runs before the UPDATE, and the
   * re-index runs after. Every caller must already sit inside
   * exec.transaction() — a failure between the two halves would otherwise
   * leave the record unindexed.
   */
  private rewriteContent(
    id: string,
    typeId: TypeId,
    content: Record<string, unknown>,
    opts: ExpectedVersionOptions & ActorOptions,
  ): void {
    const json = JSON.stringify(content);
    fts5Strategy.remove(this.exec, id);
    this.versionedUpdate(id, ['type_id = ?', 'content = ?'], [typeId, json], opts);
    fts5Strategy.insert(this.exec, id, json);
    this.syncContentIndex(id, typeId, content);
  }

  async queryRecords(query: StackQuery): Promise<QueryResult> {
    const limit = query.limit ?? 50;
    // One extra row, to learn whether a further page follows.
    const fetch = limit + 1;

    // A content-field sort answers from two statements, the records that
    // hold a value at the field and then the records that hold none. They
    // read in order, each asking only for the rows the ones before it left
    // of the page, and the second is skipped once the first has filled it —
    // the common case, since a page rarely straddles the boundary.
    const rows: Record<string, unknown>[] = [];
    for (const page of buildQueryPlan(query)) {
      const budget = fetch - rows.length;
      if (budget <= 0) break;
      const statement = atBudget(page, budget);
      rows.push(
        ...asStackQueryError(query, () =>
          this.exec.all<Record<string, unknown>>(statement.sql, statement.params),
        ),
      );
    }

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    const records = page.map((row) => {
      const associations = this.getAssociationsForRecord(row.id as string);
      return rowToRecord(row, associations);
    });

    const lastRecord = records[records.length - 1];
    const cursor =
      hasMore && lastRecord
        ? makeCursor(lastRecord, query.sort, (record, field) => this.sortFieldKind(record, field))
        : null;

    return { records, cursor };
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

      const row = this.exec.get<{ version: number }>('SELECT version FROM records WHERE id = ?', [
        id,
      ]);
      if (!row || row.version !== version.version) throw err;

      this.overwriteVersionRow(id, version);
    }
  }

  // -------------------------------------------------------
  // Change journal
  // -------------------------------------------------------

  /**
   * Append one entry, stamping the record-derived half off the row as it
   * now stands — so every caller must already sit inside the same
   * transaction as the write it describes, after that write has landed.
   *
   * `seq` is allocated here, from the log's own max, rather than computed
   * by the caller. That is what spares this table the collision healing
   * versions needs: nothing outside this statement ever holds a seq it
   * expects to be free. See docs/spec/journal.md § Ordering.
   */
  private appendJournal(recordId: string, entry: JournalEntryInput | undefined): void {
    if (!entry) return;
    // Three columns, not readRecord(): the stamp needs version/typeId/
    // parentId and nothing else, and this runs inside every mutating
    // write — a full row plus its association set, per write, to read
    // three values. `parent_id` is used raw so the NULL/''/id spelling
    // reaches the journal exactly as the records table holds it.
    const row = this.exec.get<{
      version: number;
      type_id: string;
      parent_id: string | null;
    }>('SELECT version, type_id, parent_id FROM records WHERE id = ?', [recordId]);
    if (!row) throw new StackNotFoundError(`Record not found: "${recordId}"`);

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
      throw new StackNotFoundError(`Record not found: "${id}"`);
    }
    const conditions = ['record_id = ?'];
    const values: unknown[] = [id];
    if (query.sinceSeq !== undefined) {
      conditions.push('seq > ?');
      values.push(query.sinceSeq);
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
    const schema = type.schema as Record<string, { kind?: string }>;
    this.indexedFieldsByType.set(type.id, indexedFieldKinds(schema));
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
   * Never bumps `version`/`updatedAt` and never snapshots — see
   * StackRecordAdapter.associate(). The records row is untouched entirely;
   * only the associations table changes.
   */
  async associate(
    recordId: string,
    association: Association,
    opts: JournalOptions = {},
  ): Promise<StackRecord> {
    this.exec.transaction(() => {
      if (!this.readRecord(recordId))
        throw new StackNotFoundError(`Record not found: "${recordId}"`);
      this.insertAssociations(recordId, [association]);
      this.appendJournal(recordId, opts.journal);
    });

    return this.reread(recordId, 'associate');
  }

  /** Never bumps `version`/`updatedAt` — see associate(). */
  async dissociate(
    recordId: string,
    association: Association,
    opts: JournalOptions = {},
  ): Promise<StackRecord> {
    this.exec.transaction(() => {
      if (!this.readRecord(recordId))
        throw new StackNotFoundError(`Record not found: "${recordId}"`);
      this.exec.run(
        `DELETE FROM associations
       WHERE record_id = ?
         AND kind = ?
         AND label = ?
         AND file_id       = ?
         AND related_scope = ?
         AND related_id    = ?
         AND related_ns    = ?
         AND related_stack = ?
         AND related_role  = ?`,
        [recordId, association.kind, association.label, ...associationKeyColumns(association)],
      );
      this.appendJournal(recordId, opts.journal);
    });

    return this.reread(recordId, 'dissociate');
  }

  /** The kinds each change-set key replaces, and nothing else. */
  private static readonly DATA_KINDS = ['tag', 'attachment', 'relationship'];
  private static readonly AUTHORITY_KINDS = ['permission', 'anyone'];

  /**
   * Apply a change set's two association keys, each replacing only within
   * its own half of the partition. That partition is the whole reason a
   * tag write cannot drop an ACL: the `associations` key deletes data
   * kinds alone, so the authority rows beside them are never in scope.
   * Caller-transactional, like every write below.
   * See docs/spec/access-control.md § Record-level permissions.
   */
  private replaceAssociationHalves(recordId: string, changes: RecordChanges): void {
    if (changes.associations !== undefined) {
      this.replaceAssociations(recordId, changes.associations, SharedSqlRecordLogic.DATA_KINDS);
    }
    if (changes.permissions !== undefined) {
      this.replaceAssociations(recordId, changes.permissions, SharedSqlRecordLogic.AUTHORITY_KINDS);
    }
  }

  /**
   * Swap one half of a record's association set wholesale — the "replace,
   * don't merge" semantics a change set's association list carries.
   */
  private replaceAssociations(
    recordId: string,
    associations: Association[],
    kinds: string[],
  ): void {
    this.exec.run(
      `DELETE FROM associations WHERE record_id = ? AND kind IN (${kinds.map(() => '?').join(', ')})`,
      [recordId, ...kinds],
    );
    if (associations.length) this.insertAssociations(recordId, associations);
  }

  /**
   * Upserts on association identity: the primary key decides which row a
   * write lands on, and `attachment_record_id` — outside it — is whatever
   * the incoming association says, so re-pointing one costs no second row.
   *
   * FK enforcement (PRAGMA_FOREIGN_KEYS_ON) means inserting an
   * association against a record that doesn't exist throws — mapped
   * here to StackNotFoundError so associate() on a nonexistent record
   * fails loudly instead of silently creating an orphan row.
   */
  private insertAssociations(recordId: string, associations: Association[]): void {
    for (const assoc of associations) {
      try {
        this.exec.run(
          `INSERT INTO associations
            (record_id, kind, label, file_id, related_scope, related_id, related_ns,
             related_stack, related_role, attachment_record_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT DO UPDATE SET attachment_record_id = excluded.attachment_record_id`,
          [
            recordId,
            assoc.kind,
            assoc.label,
            ...associationKeyColumns(assoc),
            assoc.kind === 'attachment' ? (assoc.attachmentRecordId ?? '') : '',
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
   * The fields content_index covers for typeId, from the in-memory cache
   * — falling back to a `types` lookup (and populating the cache) only for
   * a typeId this process hasn't seen via saveType() yet, e.g. right after
   * open().
   */
  private getIndexedFields(typeId: string): Map<string, ScalarFieldKind> {
    const cached = this.indexedFieldsByType.get(typeId);
    if (cached) return cached;

    const typeRow = this.exec.get<{ schema: string }>('SELECT schema FROM types WHERE id = ?', [
      typeId,
    ]);
    const fields = typeRow
      ? indexedFieldKinds(JSON.parse(typeRow.schema) as Record<string, { kind?: string }>)
      : new Map<string, ScalarFieldKind>();
    this.indexedFieldsByType.set(typeId, fields);
    return fields;
  }

  /**
   * Replace a record's content_index rows with what its content currently
   * holds, on every write that can change content or typeId, so neither
   * the ordering nor the file-reference lookup can drift from the record.
   * A field holding no orderable value gets no row at all, which is what
   * puts the record at the end of a sort on that field.
   */
  private syncContentIndex(
    recordId: string,
    typeId: string,
    content: Record<string, unknown>,
  ): void {
    this.exec.run('DELETE FROM content_index WHERE record_id = ?', [recordId]);

    for (const [field, kind] of this.getIndexedFields(typeId)) {
      const entry = contentSortEntry(kind, content[field]);
      if (!entry) continue;
      const sql = `INSERT OR IGNORE INTO content_index
          (record_id, field, value_rank, num_value, text_key, text_value, file_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`;
      if (entry.kind === 'num') {
        this.exec.run(sql, [recordId, field, 0, entry.num, null, null, null]);
      } else {
        // A file-ref field's value is its file id, so the row it already
        // needs for ordering also answers the attachment filter — one
        // field is one row, whatever a query reads it for.
        const fileId = kind === 'file-ref' ? entry.text : null;
        this.exec.run(sql, [recordId, field, 1, null, entry.key, entry.text, fileId]);
      }
    }
  }

  /** The declared kind of a record's top-level `field`, if it has one. */
  private sortFieldKind(record: StackRecord, field: string): ScalarFieldKind | undefined {
    return this.getIndexedFields(record.typeId).get(field);
  }
}
