/**
 * Same surface as index.ts, minus the token-store pieces
 * (TOKENS_SCHEMA_SQL, SharedTokenLogic) and the file-lock helpers
 * (acquireLock/releaseLock). A record-only SQLite engine — one with no
 * separate token file and no lock file, e.g. a Durable Object, where the
 * platform's single-writer-per-id model already is the lock — imports
 * this instead of the full barrel so its bundle never reaches
 * token-logic.ts's `node:crypto` import. That module is a real Node
 * built-in outside a `nodejs_compat` Worker, and esbuild can't always
 * fully eliminate an unused-but-reachable class export's module-level
 * imports the way it does for lock.ts's plain functions — so avoiding the
 * import (not just the unused export) has to happen at this file's level.
 */
export {
  RECORD_SCHEMA_SQL,
  FTS5_SCHEMA_SQL,
  PRAGMA_FOREIGN_KEYS_ON,
  PRAGMA_JOURNAL_MODE_WAL,
} from './schema.js';
export {
  buildFromClause,
  buildWhereClause,
  buildOrderClause,
  getSortField,
  getSortColumn,
} from './query.js';
export {
  encodeCursor,
  decodeCursor,
  makeCursor,
  SORT_FIELDS,
  type SortField,
  type DecodedCursor,
} from './cursor.js';
export { rowToRecord, rowToAssociation, rowToType, rowToVersion, toMs, fromMs } from './mappers.js';
export { sanitizeFts5Query, fts5Strategy } from './fts5.js';
export {
  type SqlExecutor,
  isForeignKeyViolation,
  isUniqueConstraintViolation,
} from './executor.js';
export { insertConfigRecord, readStackConfig, type StackConfig } from './config.js';
export { SharedSqlRecordLogic, type SharedSqlRecordLogicDeps } from './record-logic.js';
