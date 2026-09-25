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
 * This class itself is a thin binding: the one piece of genuinely
 * engine-specific wiring — SqlExecutor.transaction() reaching
 * ctx.storage.transactionSync() instead of raw SQL BEGIN/COMMIT/ROLLBACK,
 * which DO SQLite rejects outright — lives in executor.ts. Everything
 * above storage comes from @haverstack/sqlite-shared's
 * SharedSqlRecordAdapter, exactly as it does for record-adapter-sqlite.
 */

import {
  applyRecordSchema,
  insertConfigRecord,
  tryReadStackConfig,
  SharedSqlRecordAdapter,
  type StackConfig,
} from '@haverstack/sqlite-shared/record';
import { DurableObjectSqliteExecutor } from './executor.js';

// -------------------------------------------------------
// Types
// -------------------------------------------------------

export type DoSQLiteRecordAdapterOpenOrInitializeOptions = {
  /** Entity ID of the stack owner. Ignored if the DO's storage already has a config record. */
  ownerEntityId: string;
  /** IANA timezone string e.g. "America/New_York". Optional passthrough app metadata — no default. */
  timezone?: string;
};

// -------------------------------------------------------
// DoSQLiteRecordAdapter
// -------------------------------------------------------

export class DoSQLiteRecordAdapter extends SharedSqlRecordAdapter {
  private constructor(exec: DurableObjectSqliteExecutor, config: StackConfig) {
    super(exec, config);
  }

  /**
   * Open the adapter for a DO instance, initializing its storage on first
   * use — LocalAdapter.openOrInitialize()'s counterpart. There is no
   * separate initialize()/open() the way file-based adapters need one: a
   * DO id either already has a config record (reattach,
   * opts.ownerEntityId/timezone ignored in favor of what's stored) or it
   * doesn't (first call — opts.ownerEntityId/timezone become the config).
   * Schema DDL is `CREATE TABLE IF NOT EXISTS`, so running it every call
   * is idempotent and cheap.
   *
   * DO SQLite manages its own durability and rejects PRAGMA journal_mode
   * outright ("not authorized") — verified against the real runtime, not
   * assumed — hence `wal: false`, unlike record-adapter-sqlite.
   */
  static async openOrInitialize(
    storage: DurableObjectStorage,
    opts: DoSQLiteRecordAdapterOpenOrInitializeOptions,
  ): Promise<DoSQLiteRecordAdapter> {
    const exec = new DurableObjectSqliteExecutor(storage);
    applyRecordSchema(exec, { wal: false });
    const config =
      tryReadStackConfig(exec) ?? insertConfigRecord(exec, opts.ownerEntityId, opts.timezone);
    return new DoSQLiteRecordAdapter(exec, config);
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
