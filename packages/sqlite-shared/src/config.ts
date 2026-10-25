import { FormatMismatchError } from '@haverstack/core/adapter';
import type { StackIdentity } from '@haverstack/core/adapter';
import type { SqlExecutor } from './executor.js';
import { FORMAT_VERSION } from './schema.js';

/** The one place the singleton record's id is spelled. */
const CONFIG_ROW_SQL = `SELECT content FROM records WHERE id = '_config'`;

const hasTable = (exec: SqlExecutor, name: string): boolean =>
  exec.get(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`, [name]) !== undefined;

/**
 * Writes what a new store is created with — its `format` row and the
 * singleton _config@1 record — in one transaction, so neither exists without
 * the other, and returns the identity so a caller that has just created a
 * database reaches what an existing one yields without a read-back. Only
 * valid on a freshly-created database.
 */
export const insertConfigRecord = (exec: SqlExecutor, identity: StackIdentity): StackIdentity => {
  const now = Date.now();
  exec.transaction(() => {
    exec.run('INSERT INTO format (id, version) VALUES (1, ?)', [FORMAT_VERSION]);
    exec.run(
      `INSERT INTO records (id, type_id, created_at, updated_at, content, version)
       VALUES ('_config', '_config@1', ?, ?, ?, 1)`,
      [now, now, JSON.stringify({ entityId: identity.ownerEntityId, timezone: identity.timezone })],
    );
  });
  return identity;
};

/**
 * The identity a store holds, or null when it holds none: a store exists
 * exactly when it has its _config@1 record, so one left with tables and no
 * record is new. An existing store is refused in any layout but
 * FORMAT_VERSION, before the schema is applied to it — a store moves to
 * another layout only by being copied into one. Reads only.
 * See docs/spec/portability.md § The portable format.
 */
export const readStoredIdentity = (exec: SqlExecutor, where: string): StackIdentity | null => {
  const row = hasTable(exec, 'records') ? exec.get<{ content: string }>(CONFIG_ROW_SQL) : undefined;
  if (!row) return null;
  const version = hasTable(exec, 'format')
    ? exec.get<{ version: number }>('SELECT version FROM format WHERE id = 1')?.version
    : undefined;
  if (version !== FORMAT_VERSION) throw new FormatMismatchError(FORMAT_VERSION, version, where);
  const content = JSON.parse(row.content) as { entityId: string; timezone?: string };
  return { ownerEntityId: content.entityId, timezone: content.timezone };
};
