/**
 * Haverstack — Native SQLite Record Adapter
 * -------------------------------------------------------
 * Implements StackRecordAdapter using node:sqlite (Node's built-in
 * SQLite binding, Node >= 22.5). No native compilation, no node-gyp,
 * no prebuilt binaries, and writes go straight to the file via normal
 * SQLite journaling (WAL mode) — no whole-database rewrite per write,
 * no in-memory copy of the whole store, real OS-level file locking.
 * Full-text search uses FTS5.
 *
 * A stack file is owned by exactly one process at a time (see
 * docs/spec/adapters.md § Concurrency & storage ownership). open()/initialize()
 * acquire a PID-stamped lock file beside the database and reject if
 * another live process already holds it; close() releases it.
 *
 * Token storage is a separate concern — see NativeTokenStore in this
 * package, which implements @haverstack/core's StackTokenStore against
 * its own file rather than this adapter's records database.
 *
 * This class itself is a thin node:sqlite binding: opening the file, the
 * storage-ownership lock, and the WAL checkpoint are what's genuinely
 * engine-specific and live here. Everything above storage comes from
 * @haverstack/sqlite-shared's SharedSqlRecordAdapter, reached through the
 * SqlExecutor interface (NativeSqliteExecutor here normalizes node:sqlite's
 * spread-args run/get/all calls to it).
 */

import { DatabaseSync } from './node-sqlite.js';
import { existsSync } from 'fs';
import {
  applyRecordSchema,
  acquireLock,
  releaseLock,
  insertConfigRecord,
  readStackConfig,
  SharedSqlRecordAdapter,
  type StackConfig,
} from '@haverstack/sqlite-shared';
import { NativeSqliteExecutor } from './executor.js';

// -------------------------------------------------------
// Types
// -------------------------------------------------------

export type NativeSQLiteRecordAdapterInitializeOptions = {
  /** Absolute path to the .db file. Must not already exist. */
  path: string;
  /** IANA timezone string e.g. "America/New_York". Optional passthrough app metadata — no default. */
  timezone?: string;
  /** Entity ID of the stack owner. */
  ownerEntityId: string;
  /** Bypass the storage-ownership lock check. See NativeSQLiteRecordAdapterOpenOptions.force. */
  force?: boolean;
};

export type NativeSQLiteRecordAdapterOpenOptions = {
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
// NativeSQLiteRecordAdapter
// -------------------------------------------------------

export class NativeSQLiteRecordAdapter extends SharedSqlRecordAdapter {
  private constructor(
    private readonly path: string,
    private readonly db: DatabaseSync,
    exec: NativeSqliteExecutor,
    config: StackConfig,
  ) {
    super(exec, config);
  }

  /**
   * Takes the storage-ownership lock, opens the file, and brings the
   * schema up. Shared by initialize() and open(), which differ only in
   * whether the file may already exist and in where the config record
   * comes from.
   */
  private static attach(
    path: string,
    force: boolean | undefined,
  ): [DatabaseSync, NativeSqliteExecutor] {
    acquireLock(path, force);
    const db = new DatabaseSync(path);
    const exec = new NativeSqliteExecutor(db);
    applyRecordSchema(exec, { wal: true });
    return [db, exec];
  }

  /**
   * Initialize a new stack database. Fails if the file already exists —
   * use open() for existing databases.
   */
  static async initialize(
    opts: NativeSQLiteRecordAdapterInitializeOptions,
  ): Promise<NativeSQLiteRecordAdapter> {
    if (existsSync(opts.path)) {
      throw new Error(
        `Cannot initialize: database already exists at "${opts.path}". ` +
          `Use NativeSQLiteRecordAdapter.open() instead.`,
      );
    }
    const [db, exec] = NativeSQLiteRecordAdapter.attach(opts.path, opts.force);
    const config = insertConfigRecord(exec, opts.ownerEntityId, opts.timezone);
    return new NativeSQLiteRecordAdapter(opts.path, db, exec, config);
  }

  /**
   * Open an existing stack database. Fails if the file does not exist —
   * use initialize() for new databases.
   */
  static async open(
    opts: NativeSQLiteRecordAdapterOpenOptions,
  ): Promise<NativeSQLiteRecordAdapter> {
    if (!existsSync(opts.path)) {
      throw new Error(
        `Cannot open: no database found at "${opts.path}". ` +
          `Use NativeSQLiteRecordAdapter.initialize() to create one.`,
      );
    }
    const [db, exec] = NativeSQLiteRecordAdapter.attach(opts.path, opts.force);
    return new NativeSQLiteRecordAdapter(opts.path, db, exec, readStackConfig(exec));
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
  type NativeTokenStoreOpenOptions,
} from './token-store.js';
