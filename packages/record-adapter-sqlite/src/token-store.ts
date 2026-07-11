/**
 * Bearer-token storage backing @haverstack/core's StackTokenStore,
 * implemented against its own file — deliberately separate from
 * NativeSQLiteRecordAdapter's records database. The portable stack file
 * is "your data, take it with you"; auth material shouldn't travel with
 * it, and restoring a backup shouldn't resurrect revoked tokens. Server
 * implementations wire these up as separate parts
 * (`{ adapter, tokens }`), the same philosophy as combineAdapters().
 */

import { createHash, randomBytes } from 'node:crypto';
import type { StackTokenStore, TokenInfo } from '@haverstack/core';
import {
  TOKENS_SCHEMA_SQL,
  PRAGMA_JOURNAL_MODE_WAL,
  toMs,
  fromMs,
  acquireLock,
  releaseLock,
} from '@haverstack/sqlite-shared';
import { DatabaseSync } from './node-sqlite.js';

/** Conventional sibling path for a token store beside a stack's main .db file. */
export const defaultTokenStorePath = (dbPath: string): string => `${dbPath}.tokens`;

export type NativeTokenStoreOptions = {
  /** Absolute path to the token store file. Created if it doesn't exist. */
  path: string;
  /** Bypass the storage-ownership lock check. See docs/spec.md § Concurrency & storage ownership. */
  force?: boolean;
};

export class NativeTokenStore implements StackTokenStore {
  private db!: DatabaseSync;

  private constructor(private readonly path: string) {}

  /** Opens the token store, creating the file and schema if needed. */
  static async open(opts: NativeTokenStoreOptions): Promise<NativeTokenStore> {
    acquireLock(opts.path, opts.force);
    const store = new NativeTokenStore(opts.path);
    store.db = new DatabaseSync(opts.path);
    store.db.exec(PRAGMA_JOURNAL_MODE_WAL);
    store.db.exec(TOKENS_SCHEMA_SQL);
    return store;
  }

  async createToken(
    entityId: string,
    opts: { label?: string; expiresAt?: Date } = {},
  ): Promise<{ id: string; token: string }> {
    const id = randomBytes(8).toString('hex');
    const token = randomBytes(32).toString('hex');
    const tokenHash = createHash('sha256').update(token).digest('hex');
    this.db
      .prepare(
        'INSERT INTO tokens (id, token_hash, entity_id, label, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(
        id,
        tokenHash,
        entityId,
        opts.label ?? null,
        toMs(new Date()),
        opts.expiresAt ? toMs(opts.expiresAt) : null,
      );
    return { id, token };
  }

  async lookupToken(token: string): Promise<{ entityId: string } | null> {
    const hash = createHash('sha256').update(token).digest('hex');
    const row = this.db
      .prepare('SELECT entity_id, expires_at FROM tokens WHERE token_hash = ?')
      .get(hash) as { entity_id: string; expires_at: number | null } | undefined;
    if (!row) return null;
    if (row.expires_at !== null && Date.now() > row.expires_at) return null;
    return { entityId: row.entity_id };
  }

  async listTokens(): Promise<TokenInfo[]> {
    const rows = this.db
      .prepare(
        'SELECT id, entity_id, label, created_at, expires_at FROM tokens ORDER BY created_at DESC',
      )
      .all() as {
      id: string;
      entity_id: string;
      label: string | null;
      created_at: number;
      expires_at: number | null;
    }[];
    return rows.map((row) => ({
      id: row.id,
      entityId: row.entity_id,
      ...(row.label && { label: row.label }),
      createdAt: fromMs(row.created_at),
      ...(row.expires_at !== null && { expiresAt: fromMs(row.expires_at) }),
    }));
  }

  async revokeToken(id: string): Promise<void> {
    this.db.prepare('DELETE FROM tokens WHERE id = ?').run(id);
  }

  async close(): Promise<void> {
    this.db.close();
    releaseLock(this.path);
  }
}
