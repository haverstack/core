/**
 * Bearer-token storage backing @haverstack/core's StackTokenStore,
 * implemented against its own file — deliberately separate from
 * NativeSQLiteRecordAdapter's records database. The portable stack file
 * is "your data, take it with you"; auth material shouldn't travel with
 * it, and restoring a backup shouldn't resurrect revoked tokens. Server
 * implementations wire these up as separate parts
 * (`{ adapter, tokens }`), the same philosophy as combineAdapters().
 *
 * The actual createToken/lookupToken/listTokens/revokeToken logic lives
 * in @haverstack/sqlite-shared's SharedTokenLogic, reached through the
 * SqlExecutor interface.
 */

import type { StackTokenStore, TokenInfo, TokenSession } from '@haverstack/core';
import {
  TOKENS_SCHEMA_SQL,
  PRAGMA_JOURNAL_MODE_WAL,
  acquireLock,
  releaseLock,
  SharedTokenLogic,
} from '@haverstack/sqlite-shared';
import { DatabaseSync } from './node-sqlite.js';
import { NativeSqliteExecutor } from './executor.js';

/** Conventional sibling path for a token store beside a stack's main .db file. */
export const defaultTokenStorePath = (dbPath: string): string => `${dbPath}.tokens`;

export type NativeTokenStoreOptions = {
  /** Absolute path to the token store file. Created if it doesn't exist. */
  path: string;
  /** Bypass the storage-ownership lock check. See docs/spec/adapters.md § Concurrency & storage ownership. */
  force?: boolean;
};

export class NativeTokenStore implements StackTokenStore {
  private db!: DatabaseSync;
  private tokens!: SharedTokenLogic;

  private constructor(private readonly path: string) {}

  /** Opens the token store, creating the file and schema if needed. */
  static async open(opts: NativeTokenStoreOptions): Promise<NativeTokenStore> {
    acquireLock(opts.path, opts.force);
    const store = new NativeTokenStore(opts.path);
    store.db = new DatabaseSync(opts.path);
    store.db.exec(PRAGMA_JOURNAL_MODE_WAL);
    store.db.exec(TOKENS_SCHEMA_SQL);
    store.tokens = new SharedTokenLogic({ exec: new NativeSqliteExecutor(store.db) });
    return store;
  }

  createToken(
    principalId: string,
    opts?: { onBehalfOf?: string; label?: string; expiresAt?: Date },
  ): Promise<{ id: string; token: string }> {
    return this.tokens.createToken(principalId, opts);
  }

  lookupToken(token: string): Promise<TokenSession | null> {
    return this.tokens.lookupToken(token);
  }

  listTokens(): Promise<TokenInfo[]> {
    return this.tokens.listTokens();
  }

  revokeToken(id: string): Promise<void> {
    return this.tokens.revokeToken(id);
  }

  async close(): Promise<void> {
    this.db.close();
    releaseLock(this.path);
  }
}
