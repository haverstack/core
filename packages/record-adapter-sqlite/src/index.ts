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
 * docs/spec/adapters.md § Concurrency & storage ownership). open()
 * acquires a PID-stamped lock file beside the database and rejects if
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
import { OwnerMismatchError } from '@haverstack/core/adapter';
import { NativeSqliteExecutor } from './executor.js';

// -------------------------------------------------------
// Types
// -------------------------------------------------------

/** What open() does when the store is missing or present, like O_CREAT / O_EXCL. */
export type StoreCreateMode = 'never' | 'ifMissing' | 'exclusive';

/** A plain DID, or a lazy provider called only when a store is actually created. */
export type OwnerEntityIdInput = string | (() => string | Promise<string>);

export type NativeSQLiteRecordAdapterOpenOptions = {
  /** Absolute path to the .db file. */
  path: string;
  /** IANA timezone string e.g. "America/New_York". Consulted only when a store is created. No default. */
  timezone?: string;
  /**
   * Open even if a lock file from another live process is present.
   * Only needed if that process is gone but its PID was reused by
   * something else (the automatic stale-lock check already reclaims
   * locks whose owning process is no longer running).
   */
  force?: boolean;
} & (
  | {
      /** Open an existing store; fail if the file is missing. */
      create?: 'never';
      /** Checked against the existing store's owner; a mismatch throws OwnerMismatchError. */
      ownerEntityId?: string;
    }
  | {
      /** `'ifMissing'` opens the store if present and creates it if not; `'exclusive'` creates it and fails if present. */
      create: 'ifMissing' | 'exclusive';
      /**
       * Owner of a newly created store. A plain string is also checked against an
       * existing store's owner; a lazy provider is never called just to compare.
       */
      ownerEntityId: OwnerEntityIdInput;
    }
);

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
   * Opens or creates the stack database at `path` according to `create`.
   * Takes the storage-ownership lock first and releases it again if the
   * open fails, since the caller never receives an adapter to close.
   * See docs/spec/adapters.md § Construction.
   */
  static async open(
    opts: NativeSQLiteRecordAdapterOpenOptions,
  ): Promise<NativeSQLiteRecordAdapter> {
    const mode: StoreCreateMode = opts.create ?? 'never';
    const checkMode = (exists: boolean): void => {
      if (!exists && mode === 'never') {
        throw new Error(
          `Cannot open: no database found at "${opts.path}". ` +
            `Pass create: 'ifMissing' or 'exclusive' to create one.`,
        );
      }
      if (exists && mode === 'exclusive') {
        throw new Error(
          `Cannot create: database already exists at "${opts.path}". ` +
            `Pass create: 'never' or 'ifMissing' to open it.`,
        );
      }
    };
    const existedBeforeLock = existsSync(opts.path);
    checkMode(existedBeforeLock);

    // Resolved before the lock is taken so a failing provider leaves nothing held.
    let newOwner: string | undefined;
    if (!existedBeforeLock) {
      newOwner =
        typeof opts.ownerEntityId === 'function' ? await opts.ownerEntityId() : opts.ownerEntityId;
      if (!newOwner) {
        throw new Error(
          `Cannot create: no ownerEntityId given for the new database at "${opts.path}".`,
        );
      }
    }

    acquireLock(opts.path, opts.force);
    let db: DatabaseSync | undefined;
    try {
      // Re-checked under the lock: another process may have created the file meanwhile.
      const exists = existsSync(opts.path);
      checkMode(exists);
      db = new DatabaseSync(opts.path);
      const exec = new NativeSqliteExecutor(db);
      applyRecordSchema(exec, { wal: true });
      let config: StackConfig;
      if (exists) {
        config = readStackConfig(exec);
        if (typeof opts.ownerEntityId === 'string' && opts.ownerEntityId !== config.entityId) {
          throw new OwnerMismatchError(opts.ownerEntityId, config.entityId, `"${opts.path}"`);
        }
      } else {
        if (!newOwner) throw new Error(`Cannot create: "${opts.path}" vanished while opening.`);
        config = insertConfigRecord(exec, newOwner, opts.timezone);
      }
      return new NativeSQLiteRecordAdapter(opts.path, db, exec, config);
    } catch (err) {
      db?.close();
      releaseLock(opts.path);
      throw err;
    }
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
