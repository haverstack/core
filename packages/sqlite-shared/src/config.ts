import { FormatMismatchError } from '@haverstack/core/adapter';
import type { SqlExecutor } from './executor.js';

/** The layout this code reads and writes: what a new store's `format` row names. */
export const FORMAT_VERSION = 1;

/** timezone is optional passthrough app metadata — no default. */
export type StackConfig = { entityId: string; timezone: string | undefined };

/** The one place the singleton record's id is spelled. */
const CONFIG_ROW_SQL = `SELECT content FROM records WHERE id = '_config'`;

/**
 * Writes what a new store is created with — its `format` row and the
 * singleton _config@1 record — and returns the config, so a caller that has
 * just created a database reaches the same StackConfig an existing one
 * yields without a read-back. Only valid on a freshly-created database.
 */
export const insertConfigRecord = (
  exec: SqlExecutor,
  entityId: string,
  timezone: string | undefined,
): StackConfig => {
  const now = Date.now();
  exec.run('INSERT INTO format (id, version) VALUES (1, ?)', [FORMAT_VERSION]);
  exec.run(
    `INSERT INTO records (id, type_id, created_at, updated_at, content, version)
     VALUES ('_config', '_config@1', ?, ?, ?, 1)`,
    [now, now, JSON.stringify({ entityId, timezone })],
  );
  return { entityId, timezone };
};

/**
 * Reads the singleton _config@1 record, or null if this database has none.
 * Null is the signal an engine that cannot tell from the outside whether a
 * store exists (a Durable Object) uses to decide between reattaching and creating.
 */
export const tryReadStackConfig = (exec: SqlExecutor): StackConfig | null => {
  const row = exec.get<{ content: string }>(CONFIG_ROW_SQL);
  if (!row) return null;
  const content = JSON.parse(row.content) as { entityId: string; timezone?: string };
  return { entityId: content.entityId, timezone: content.timezone };
};

/** Reads the singleton _config@1 record. Throws if the database is missing it. */
export const readStackConfig = (exec: SqlExecutor): StackConfig => {
  const config = tryReadStackConfig(exec);
  if (!config) throw new Error('Stack database is missing its config record.');
  return config;
};

/**
 * Refuses an existing store in any layout but FORMAT_VERSION: a store moves
 * to a new layout only by being copied into one. `where` names the store,
 * as OwnerMismatchError's does.
 */
export const assertFormatVersion = (exec: SqlExecutor, where: string): void => {
  const version = exec.get<{ version: number }>('SELECT version FROM format WHERE id = 1')?.version;
  if (version !== FORMAT_VERSION) throw new FormatMismatchError(FORMAT_VERSION, version, where);
};
