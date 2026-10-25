import { describe, test, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { FormatMismatchError } from '@haverstack/core/adapter';
import { insertConfigRecord, readStoredIdentity } from '../src/config.js';
import type { SqlExecutor } from '../src/executor.js';
import { applyRecordSchema, FORMAT_VERSION } from '../src/schema.js';

const executor = (db: DatabaseSync): SqlExecutor => ({
  exec: (sql) => db.exec(sql),
  run: (sql, params = []) => Number(db.prepare(sql).run(...(params as never[])).changes),
  get: <T>(sql: string, params: readonly unknown[] = []) =>
    db.prepare(sql).get(...(params as never[])) as T | undefined,
  all: <T>(sql: string, params: readonly unknown[] = []) =>
    db.prepare(sql).all(...(params as never[])) as T[],
  transaction<T>(fn: () => T): T {
    db.exec('BEGIN');
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  },
});

/** A schema-applied, empty database: what a store looks like before it is created. */
const blank = () => {
  const exec = executor(new DatabaseSync(':memory:'));
  applyRecordSchema(exec, { wal: false });
  return exec;
};

const tables = (exec: SqlExecutor) =>
  exec.all<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table'`).length;

describe('readStoredIdentity', () => {
  test('is null for a database with no tables at all', () => {
    expect(readStoredIdentity(executor(new DatabaseSync(':memory:')), 'here')).toBeNull();
  });

  // A store exists exactly when it has its _config record, so one left with
  // tables and no record by an interrupted create is created afresh.
  test('is null for a store with tables but no config record', () => {
    expect(readStoredIdentity(blank(), 'here')).toBeNull();
  });

  test('reads back the identity a create wrote, an absent timezone kept as a key', () => {
    const exec = blank();
    insertConfigRecord(exec, { ownerEntityId: 'did:key:owner', timezone: undefined });
    const identity = readStoredIdentity(exec, 'here');
    expect(identity).toEqual({ ownerEntityId: 'did:key:owner', timezone: undefined });
    expect('timezone' in identity!).toBe(true);
  });

  test.each([
    ['another version', 'UPDATE format SET version = 2', 2],
    ['no version', 'DELETE FROM format', undefined],
    ['no format table', 'DROP TABLE format', undefined],
  ] as const)('refuses a store naming %s, writing nothing', (_name, sql, actual) => {
    const exec = blank();
    insertConfigRecord(exec, { ownerEntityId: 'did:key:owner', timezone: 'UTC' });
    exec.exec(sql);
    const before = tables(exec);
    const err = (() => {
      try {
        return readStoredIdentity(exec, 'here');
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(FormatMismatchError);
    expect(err).toMatchObject({ expected: FORMAT_VERSION, actual, where: 'here' });
    expect(tables(exec)).toBe(before);
  });
});

describe('insertConfigRecord', () => {
  test('returns the identity it wrote, matching what a later read yields', () => {
    const exec = blank();
    const written = insertConfigRecord(exec, { ownerEntityId: 'did:key:owner', timezone: 'UTC' });
    expect(written).toEqual(readStoredIdentity(exec, 'here'));
  });

  test('writes the format row and the config record together, or neither', () => {
    const exec = blank();
    exec.run(
      `INSERT INTO records (id, type_id, created_at, updated_at, content, version)
       VALUES ('_config', '_config@1', 0, 0, '{}', 1)`,
    );
    expect(() =>
      insertConfigRecord(exec, { ownerEntityId: 'did:key:owner', timezone: 'UTC' }),
    ).toThrow();
    expect(exec.get('SELECT 1 FROM format')).toBeUndefined();
  });
});
