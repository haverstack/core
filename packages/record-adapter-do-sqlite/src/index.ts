/**
 * Haverstack — Durable Object SQLite Record Adapter
 * -------------------------------------------------------
 * Implements StackRecordAdapter over a Cloudflare Durable Object's SQLite
 * storage (ctx.storage.sql). Full-text search uses FTS5, same as
 * record-adapter-sqlite — DO's SQLite build ships it.
 *
 * Ownership and durability come from the platform, not from anything this
 * class does: a Durable Object id maps to exactly one running instance,
 * so there is no separate lock file the way record-adapter-sqlite needs
 * one for real files (see docs/spec/adapters.md § Concurrency & storage
 * ownership) — the DO *is* the lock. There is likewise no persist/flush
 * step: every write through ctx.storage.sql is durable by the time the
 * call returns, so flush()/close() are no-ops kept only to satisfy the
 * optional StackRecordAdapter methods.
 *
 * This class itself is a thin binding: schema setup and the one piece of
 * genuinely engine-specific wiring — SqlExecutor.transaction() reaching
 * ctx.storage.transactionSync() instead of raw SQL BEGIN/COMMIT/ROLLBACK,
 * which DO SQLite rejects outright — live here (see executor.ts). The
 * actual StackRecordAdapter logic lives in @haverstack/sqlite-shared's
 * SharedSqlRecordLogic, exactly as it does for record-adapter-sqlite.
 */

import type { StackType, TypeId, FileId, RecordVersion, ActorOptions } from '@haverstack/core';
import type {
  StackRecord,
  StackQuery,
  QueryResult,
  Association,
  Permission,
} from '@haverstack/core';
import type { StackRecordAdapter, AdapterCapabilities } from '@haverstack/core/adapter';
import {
  RECORD_SCHEMA_SQL,
  FTS5_SCHEMA_SQL,
  PRAGMA_FOREIGN_KEYS_ON,
  insertConfigRecord,
  readStackConfig,
  SharedSqlRecordLogic,
} from '@haverstack/sqlite-shared/record';
import { DurableObjectSqliteExecutor } from './executor.js';

// -------------------------------------------------------
// Types
// -------------------------------------------------------

export type DoRecordCreateOptions = {
  /** Entity ID of the stack owner. Ignored if the DO's storage already has a config record. */
  entityId: string;
  /** IANA timezone string e.g. "America/New_York". Optional passthrough app metadata — no default. */
  timezone?: string;
};

// -------------------------------------------------------
// DoSQLiteRecordAdapter
// -------------------------------------------------------

export class DoSQLiteRecordAdapter implements StackRecordAdapter {
  readonly capabilities: AdapterCapabilities = {
    fullTextSearch: true,
    contentFieldQuery: true,
    nestedContentQuery: true,
    contentPresenceQuery: true,
    contentFieldSort: true,
    sortableFields: ['createdAt', 'updatedAt', 'version'],
    maxAttachmentBytes: null,
    maxContentBytes: null,
  };

  ownerEntityId!: string;
  timezone: string | undefined;

  private readonly record: SharedSqlRecordLogic;

  private constructor(private readonly exec: DurableObjectSqliteExecutor) {
    this.record = new SharedSqlRecordLogic({ exec });
  }

  /**
   * Create (or reattach to) the adapter for a DO instance. There is no
   * initialize()/open() split the way file-based adapters need one: a DO
   * id either already has a config record (a previous call created it —
   * reattach, opts.entityId/timezone ignored in favor of what's stored)
   * or it doesn't (first call — opts.entityId/timezone become the config).
   * Schema DDL is `CREATE TABLE IF NOT EXISTS`, so running it every call
   * is idempotent and cheap.
   */
  static async create(
    storage: DurableObjectStorage,
    opts: DoRecordCreateOptions,
  ): Promise<DoSQLiteRecordAdapter> {
    const exec = new DurableObjectSqliteExecutor(storage);
    exec.exec(RECORD_SCHEMA_SQL);
    exec.exec(FTS5_SCHEMA_SQL);
    exec.exec(PRAGMA_FOREIGN_KEYS_ON);
    // DO SQLite manages its own durability and rejects PRAGMA journal_mode
    // outright ("not authorized") — verified against the real runtime, not
    // assumed — so unlike record-adapter-sqlite, no WAL pragma runs here.

    const adapter = new DoSQLiteRecordAdapter(exec);
    const existing = exec.get<{ content: string }>(
      `SELECT content FROM records WHERE id = '_config'`,
    );
    if (existing) {
      const config = readStackConfig(exec);
      adapter.ownerEntityId = config.entityId;
      adapter.timezone = config.timezone;
    } else {
      insertConfigRecord(exec, opts.entityId, opts.timezone);
      adapter.ownerEntityId = opts.entityId;
      adapter.timezone = opts.timezone;
    }
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
    opts?: { expectedVersion?: number; snapshot?: RecordVersion } & ActorOptions,
  ): Promise<StackRecord> {
    return this.record.patchContent(id, patch, opts);
  }

  deleteRecord(
    id: string,
    opts?: { hard?: boolean; expectedVersion?: number; snapshot?: RecordVersion } & ActorOptions,
  ): Promise<StackRecord | null> {
    return this.record.deleteRecord(id, opts);
  }

  undeleteRecord(
    id: string,
    opts?: { expectedVersion?: number; snapshot?: RecordVersion } & ActorOptions,
  ): Promise<StackRecord> {
    return this.record.undeleteRecord(id, opts);
  }

  setPermissions(
    id: string,
    permissions: Permission[],
    opts?: { expectedVersion?: number; snapshot?: RecordVersion } & ActorOptions,
  ): Promise<StackRecord> {
    return this.record.setPermissions(id, permissions, opts);
  }

  setUnlisted(
    id: string,
    unlisted: boolean,
    opts?: { expectedVersion?: number; snapshot?: RecordVersion } & ActorOptions,
  ): Promise<StackRecord> {
    return this.record.setUnlisted(id, unlisted, opts);
  }

  restoreVersion(
    id: string,
    version: number,
    opts?: { expectedVersion?: number; snapshot?: RecordVersion } & ActorOptions,
  ): Promise<StackRecord> {
    return this.record.restoreVersion(id, version, opts);
  }

  commitMigration(
    id: string,
    toTypeId: TypeId,
    content: Record<string, unknown>,
    opts?: { expectedVersion?: number; snapshot?: RecordVersion } & ActorOptions,
  ): Promise<StackRecord> {
    return this.record.commitMigration(id, toTypeId, content, opts);
  }

  queryRecords(query: StackQuery): Promise<QueryResult> {
    return this.record.queryRecords(query);
  }

  deleteUnreferencedAttachmentRecords(
    fileId: FileId,
    metadataTypeIds: TypeId[],
  ): Promise<StackRecord[]> {
    return this.record.deleteUnreferencedAttachmentRecords(fileId, metadataTypeIds);
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
    opts?: { expectedVersion?: number; snapshot?: RecordVersion } & ActorOptions,
  ): Promise<StackRecord> {
    return this.record.associate(recordId, association, opts);
  }

  dissociate(
    recordId: string,
    association: Association,
    opts?: { expectedVersion?: number; snapshot?: RecordVersion } & ActorOptions,
  ): Promise<StackRecord> {
    return this.record.dissociate(recordId, association, opts);
  }

  // -------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------

  /** No-op: every write through ctx.storage.sql is already durable. */
  async flush(): Promise<void> {}

  /** No-op: no lock file, no connection to release — the DO's own lifecycle governs storage. */
  async close(): Promise<void> {}
}

export { DurableObjectSqliteExecutor } from './executor.js';
