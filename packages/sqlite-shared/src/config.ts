import { FormatMismatchError } from '@haverstack/core/adapter';
import type { StackIdentity } from '@haverstack/core/adapter';
import type { SqlExecutor } from './executor.js';
import { FORMAT_VERSION, FTS5_SCHEMA_SQL, RECORD_SCHEMA_SQL } from './schema.js';

/** The one place the singleton record's id is spelled. */
const CONFIG_ROW_SQL = `SELECT content FROM records WHERE id = '_config'`;

const hasTable = (exec: SqlExecutor, name: string): boolean =>
  exec.get(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`, [name]) !== undefined;

/**
 * Writes everything a new store is created with — its tables, its `format`
 * row and the singleton _config@1 record — in one transaction, so a store is
 * either whole or not there. Returns the identity so a caller that has just
 * created a database reaches what an existing one yields without a
 * read-back. Only valid on a database readStoredIdentity() found missing.
 */
export const writeNewStore = (exec: SqlExecutor, identity: StackIdentity): StackIdentity => {
  const now = Date.now();
  exec.transaction(() => {
    exec.exec(RECORD_SCHEMA_SQL);
    exec.exec(FTS5_SCHEMA_SQL);
    exec.run('INSERT INTO format (id, version) VALUES (1, ?)', [FORMAT_VERSION]);
    exec.run(
      `INSERT INTO records (id, type_id, created_at, updated_at, content, version)
       VALUES ('_config', '_config@1', ?, ?, ?, 1)`,
      [now, now, JSON.stringify(identity)],
    );
  });
  return identity;
};

/**
 * The identity a store holds, or null when the database holds no store.
 * Stores are written whole, so a database with neither a `records` nor a
 * `format` table holds none, and one with either is a store: it must name
 * FORMAT_VERSION, or it is refused — a store moves to another layout only by
 * being copied into one. Reads only, so a refused store is left untouched.
 * See docs/spec/adapters.md § Construction.
 */
export const readStoredIdentity = (exec: SqlExecutor, where: string): StackIdentity | null => {
  const hasFormat = hasTable(exec, 'format');
  if (!hasFormat && !hasTable(exec, 'records')) return null;
  const version = hasFormat
    ? exec.get<{ version: number }>('SELECT version FROM format WHERE id = 1')?.version
    : undefined;
  if (version !== FORMAT_VERSION) throw new FormatMismatchError(FORMAT_VERSION, version, where);
  const row = exec.get<{ content: string }>(CONFIG_ROW_SQL);
  if (!row) throw new Error(`Cannot open ${where}: it holds no _config record.`);
  const content = JSON.parse(row.content) as StackIdentity;
  return { ownerEntityId: content.ownerEntityId, timezone: content.timezone };
};
