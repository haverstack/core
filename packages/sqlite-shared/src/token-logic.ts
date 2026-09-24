/**
 * The actual StackTokenStore logic (createToken/lookupToken/listTokens/
 * revokeToken), parametrized over a SqlExecutor. Currently consumed by
 * record-adapter-sqlite's NativeTokenStore, which points it at a file
 * separate from records — see TOKENS_SCHEMA_SQL in schema.ts.
 */

import { createHash, randomBytes } from 'node:crypto';
import type { Actor, TokenSession } from '@haverstack/core';
import type { TokenInfo } from '@haverstack/core/wire';
import type { SqlExecutor } from './executor.js';
import { toMs, fromMs } from './mappers.js';

/**
 * How a bearer token is reduced to what the `tokens` table stores. One
 * function because createToken and lookupToken must agree exactly — a
 * divergence would silently make every issued token unlookupable.
 */
const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');

export type SharedTokenLogicDeps = {
  exec: SqlExecutor;
};

export class SharedTokenLogic {
  constructor(private readonly deps: SharedTokenLogicDeps) {}

  private get exec(): SqlExecutor {
    return this.deps.exec;
  }

  async createToken(
    actor: Actor,
    opts: { label?: string; expiresAt?: Date } = {},
  ): Promise<{ id: string; token: string }> {
    const id = randomBytes(8).toString('hex');
    const token = randomBytes(32).toString('hex');
    const tokenHash = hashToken(token);
    this.exec.run(
      'INSERT INTO tokens (id, token_hash, principal_id, subject_id, label, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [
        id,
        tokenHash,
        // Stored rather than left null for an undelegated token, so a
        // reader never has to know which column stands in for the other.
        actor.principalId ?? actor.subjectId,
        actor.subjectId,
        opts.label ?? null,
        toMs(new Date()),
        opts.expiresAt ? toMs(opts.expiresAt) : null,
      ],
    );
    return { id, token };
  }

  async lookupToken(token: string): Promise<TokenSession | null> {
    const hash = hashToken(token);
    const row = this.exec.get<{
      principal_id: string;
      subject_id: string;
      expires_at: number | null;
    }>('SELECT principal_id, subject_id, expires_at FROM tokens WHERE token_hash = ?', [hash]);
    if (!row) return null;
    if (row.expires_at !== null && Date.now() > row.expires_at) return null;
    return { principalId: row.principal_id, subjectId: row.subject_id };
  }

  async listTokens(): Promise<TokenInfo[]> {
    const rows = this.exec.all<{
      id: string;
      principal_id: string;
      subject_id: string;
      label: string | null;
      created_at: number;
      expires_at: number | null;
    }>(
      'SELECT id, principal_id, subject_id, label, created_at, expires_at FROM tokens ORDER BY created_at DESC',
    );
    return rows.map((row) => ({
      id: row.id,
      principalId: row.principal_id,
      subjectId: row.subject_id,
      ...(row.label && { label: row.label }),
      createdAt: fromMs(row.created_at),
      ...(row.expires_at !== null && { expiresAt: fromMs(row.expires_at) }),
    }));
  }

  async revokeToken(id: string): Promise<void> {
    this.exec.run('DELETE FROM tokens WHERE id = ?', [id]);
  }
}
