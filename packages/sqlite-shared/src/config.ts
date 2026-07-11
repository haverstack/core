import type { SqlExecutor } from './executor.js';

export type StackConfig = { entityId: string; timezone: string };

/** Inserts the singleton _config@1 record. Only valid on a freshly-created database. */
export const insertConfigRecord = (exec: SqlExecutor, entityId: string, timezone: string): void => {
  const now = Date.now();
  exec.run(
    `INSERT INTO records (id, type_id, created_at, updated_at, content, version)
     VALUES ('_config', '_config@1', ?, ?, ?, 1)`,
    [now, now, JSON.stringify({ entityId, timezone })],
  );
};

/** Reads the singleton _config@1 record. Throws if the database is missing it. */
export const readStackConfig = (exec: SqlExecutor): StackConfig => {
  const row = exec.get<{ content: string }>(`SELECT content FROM records WHERE id = '_config'`);
  if (!row) throw new Error('Stack database is missing its config record.');
  const content = JSON.parse(row.content) as { entityId: string; timezone?: string };
  return { entityId: content.entityId, timezone: content.timezone ?? 'UTC' };
};
