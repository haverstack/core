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
import { existsSync, rmSync } from 'fs';
import {
  acquireLock,
  releaseLock,
  missingStoreError,
  openStore,
  SharedSqlRecordAdapter,
  type OwnerEntityIdInput,
  type StoreCreateMode,
} from '@haverstack/sqlite-shared';
import type { StackIdentity, StoreSeed } from '@haverstack/core/adapter';
import { NativeSqliteExecutor } from './executor.js';

// -------------------------------------------------------
// Types
// -------------------------------------------------------

export type { OwnerEntityIdInput, StoreCreateMode };

export type NativeSQLiteRecordAdapterOpenOptions = {
  /** Absolute path to the .db file. */
  path: string;
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
      seed?: never;
    }
  | {
      /** `'ifMissing'` opens the store if present and creates it if not; `'exclusive'` creates it and fails if present. */
      create: 'ifMissing' | 'exclusive';
      /**
       * Owner of a newly created store. A plain string is also checked against an
       * existing store's owner; a lazy provider is never called just to compare.
       */
      ownerEntityId: OwnerEntityIdInput;
      seed?: never;
    }
  | {
      /** A seed only creates, as `'exclusive'` does: an existing store refuses it. */
      create?: never;
      /** The `_config` record and history the store is created holding: a copy's source's. */
      seed: StoreSeed;
      ownerEntityId?: never;
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
    identity: StackIdentity,
  ) {
    super(exec, identity);
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
    const mode: StoreCreateMode = opts.seed ? 'exclusive' : (opts.create ?? 'never');
    const where = `"${opts.path}"`;
    // Judged before opening, which would create the file to say it is missing.
    if (mode === 'never' && !existsSync(opts.path)) throw missingStoreError(where);

    acquireLock(opts.path, opts.force);
    // Under the lock, so no other process can have made the file meanwhile.
    const madeFile = !existsSync(opts.path);
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(opts.path);
      const exec = new NativeSqliteExecutor(db);
      const identity = await openStore(exec, { ...opts, mode, where, wal: true });
      return new NativeSQLiteRecordAdapter(opts.path, db, exec, identity);
    } catch (err) {
      db?.close();
      // A failed open leaves the filesystem as it found it.
      if (madeFile) {
        for (const suffix of ['', '-wal', '-shm']) rmSync(`${opts.path}${suffix}`, { force: true });
      }
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
