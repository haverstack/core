/**
 * The actual StackTokenStore logic (createToken/lookupToken/listTokens/
 * revokeToken), parametrized over a SqlExecutor. Currently consumed by
 * record-adapter-sqlite's NativeTokenStore, which points it at a file
 * separate from records — see TOKENS_SCHEMA_SQL in schema.ts.
 */

import { createHash, randomBytes } from 'node:crypto';
import type { TokenInfo } from '@haverstack/core';
import type { SqlExecutor } from './executor.js';
import { toMs, fromMs } from './mappers.js';

export type SharedTokenLogicDeps = {
  exec: SqlExecutor;
  /** Called after every mutating operation. Omit for engines with durable writes. */
  onWrite?: () => void;
};

export class SharedTokenLogic {
  constructor(private readonly deps: SharedTokenLogicDeps) {}

  private get exec(): SqlExecutor {
    return this.deps.exec;
  }

  private write(): void {
    this.deps.onWrite?.();
  }

  async createToken(
    entityId: string,
    opts: { label?: string; expiresAt?: Date } = {},
  ): Promise<{ id: string; token: string }> {
    const id = randomBytes(8).toString('hex');
    const token = randomBytes(32).toString('hex');
    const tokenHash = createHash('sha256').update(token).digest('hex');
    this.exec.run(
      'INSERT INTO tokens (id, token_hash, entity_id, label, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
      [
        id,
        tokenHash,
        entityId,
        opts.label ?? null,
        toMs(new Date()),
        opts.expiresAt ? toMs(opts.expiresAt) : null,
      ],
    );
    this.write();
    return { id, token };
  }

  async lookupToken(token: string): Promise<{ entityId: string } | null> {
    const hash = createHash('sha256').update(token).digest('hex');
    const row = this.exec.get<{ entity_id: string; expires_at: number | null }>(
      'SELECT entity_id, expires_at FROM tokens WHERE token_hash = ?',
      [hash],
    );
    if (!row) return null;
    if (row.expires_at !== null && Date.now() > row.expires_at) return null;
    return { entityId: row.entity_id };
  }

  async listTokens(): Promise<TokenInfo[]> {
    const rows = this.exec.all<{
      id: string;
      entity_id: string;
      label: string | null;
      created_at: number;
      expires_at: number | null;
    }>('SELECT id, entity_id, label, created_at, expires_at FROM tokens ORDER BY created_at DESC');
    return rows.map((row) => ({
      id: row.id,
      entityId: row.entity_id,
      ...(row.label && { label: row.label }),
      createdAt: fromMs(row.created_at),
      ...(row.expires_at !== null && { expiresAt: fromMs(row.expires_at) }),
    }));
  }

  async revokeToken(id: string): Promise<void> {
    this.exec.run('DELETE FROM tokens WHERE id = ?', [id]);
    this.write();
  }
}
