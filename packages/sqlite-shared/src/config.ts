import {
  FormatMismatchError,
  OwnerMismatchError,
  identityOf,
  newStoreSeed,
} from '@haverstack/core/adapter';
import type { StackIdentity, StoreSeed } from '@haverstack/core/adapter';
import type { SqlExecutor } from './executor.js';
import { SharedSqlRecordLogic } from './record-logic.js';
import {
  applyConnectionPragmas,
  FORMAT_VERSION,
  FTS5_SCHEMA_SQL,
  RECORD_SCHEMA_SQL,
} from './schema.js';

/** What open() does when the store is missing or present, like O_CREAT / O_EXCL. */
export type StoreCreateMode = 'never' | 'ifMissing' | 'exclusive';

/** A plain DID, or a lazy provider called only when a store is actually created. */
export type OwnerEntityIdInput = string | (() => string | Promise<string>);

/** The one place the singleton record's id is spelled. */
const CONFIG_ROW_SQL = `SELECT content FROM records WHERE id = '_config'`;

/** The refusal of a store that is not there, for an engine to throw before it opens one. */
export const missingStoreError = (where: string): Error =>
  new Error(
    `Cannot open: no database found at ${where}. ` +
      `Pass create: 'ifMissing' or 'exclusive' to create one.`,
  );

/**
 * Writes everything a new store is created with — its tables, its `format`
 * row and the `_config` record its seed carries, with that record's history —
 * in one transaction, so a store is either whole or not there. `_config` is
 * written as importRecord() writes any Record. Only valid on a database
 * readStoredIdentity() found missing.
 */
export const writeNewStore = (exec: SqlExecutor, seed: StoreSeed): StackIdentity => {
  exec.transaction(() => {
    exec.exec(RECORD_SCHEMA_SQL);
    exec.exec(FTS5_SCHEMA_SQL);
    exec.run('INSERT INTO format (id, version) VALUES (1, ?)', [FORMAT_VERSION]);
    new SharedSqlRecordLogic({ exec }).writeImported(seed.config, seed.history);
  });
  return identityOf(seed);
};

/**
 * The identity a store holds, or null when the database holds no store.
 * Stores are written whole, so the `format` table alone says whether one is
 * there; a store must name FORMAT_VERSION, or it is refused — a store moves
 * to another layout only by being copied into one. Reads only, so a refused
 * store is left untouched. See docs/spec/adapters.md § Construction.
 */
export const readStoredIdentity = (exec: SqlExecutor, where: string): StackIdentity | null => {
  const hasFormat =
    exec.get(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'format'`) !== undefined;
  if (!hasFormat) return null;
  const version = exec.get<{ version: number }>('SELECT version FROM format WHERE id = 1')?.version;
  if (version !== FORMAT_VERSION) throw new FormatMismatchError(FORMAT_VERSION, version, where);
  const { content } = exec.get<{ content: string }>(CONFIG_ROW_SQL)!;
  const config = JSON.parse(content) as StackIdentity;
  return { ownerEntityId: config.ownerEntityId, timezone: config.timezone };
};

export type OpenStoreOptions = {
  /** Names the store in a refusal, as OwnerMismatchError's `where` does. */
  where: string;
  mode: StoreCreateMode;
  wal: boolean;
} & (
  | { ownerEntityId?: OwnerEntityIdInput; timezone?: string; seed?: never }
  | { seed: StoreSeed; ownerEntityId?: never; timezone?: never }
);

/**
 * Every SQLite engine's open, after it holds a connection: read what the
 * store holds, judge `mode` by it, check the owner a caller expects, and
 * create a missing store from `seed` or a fresh one. The one read answers
 * whether a store is present, its layout and its owner, so those checks
 * cannot disagree. See docs/spec/adapters.md § Construction.
 */
export const openStore = async (
  exec: SqlExecutor,
  opts: OpenStoreOptions,
): Promise<StackIdentity> => {
  const stored = readStoredIdentity(exec, opts.where);
  if (!stored && opts.mode === 'never') throw missingStoreError(opts.where);
  if (stored && opts.mode === 'exclusive') {
    throw new Error(
      `Cannot create: database already exists at ${opts.where}. ` +
        `Pass create: 'never' or 'ifMissing' to open it.`,
    );
  }
  applyConnectionPragmas(exec, { wal: opts.wal });

  if (stored) {
    const expected = opts.seed
      ? identityOf(opts.seed).ownerEntityId
      : typeof opts.ownerEntityId === 'string'
        ? opts.ownerEntityId
        : undefined;
    if (expected !== undefined && expected !== stored.ownerEntityId) {
      throw new OwnerMismatchError(expected, stored.ownerEntityId, opts.where);
    }
    return stored;
  }

  if (opts.seed) return writeNewStore(exec, opts.seed);
  // Resolved only now a store is being created, and refused empty on every
  // engine. See docs/spec/adapters.md § Construction.
  const owner =
    typeof opts.ownerEntityId === 'function' ? await opts.ownerEntityId() : opts.ownerEntityId;
  if (!owner) {
    throw new Error(`Cannot create: no ownerEntityId given for the new database at ${opts.where}.`);
  }
  return writeNewStore(exec, newStoreSeed({ ownerEntityId: owner, timezone: opts.timezone }));
};
