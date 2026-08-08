import type { SqlExecutor } from './executor.js';

/**
 * The one piece of record indexing that differs between FTS4 and FTS5:
 * FTS5's external-content table needs its special `('delete', rowid,
 * content)` command to correctly unindex a row (see fts5.ts). Everything
 * else is identical, which is why only this seam is pluggable.
 */
export type FtsStrategy = {
  /** Index a record that has no FTS entry yet (used right after an INSERT). */
  insert(exec: SqlExecutor, recordId: string, content: string): void;
  /**
   * Remove a record's FTS entry. MUST be called before the records row's
   * content changes or the row is deleted, since some strategies need to
   * read the current content to build the removal.
   */
  remove(exec: SqlExecutor, recordId: string): void;
};
