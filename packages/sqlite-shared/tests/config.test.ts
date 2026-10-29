import { describe, test, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { FormatMismatchError, newStoreSeed } from '@haverstack/core/adapter';
import { openStore, writeNewStore, readStoredIdentity } from '../src/config.js';
import type { SqlExecutor } from '../src/executor.js';
import { FORMAT_VERSION } from '../src/schema.js';

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

const empty = () => executor(new DatabaseSync(':memory:'));

/** A store as a create leaves it. */
const created = () => {
  const exec = empty();
  writeNewStore(exec, newStoreSeed({ ownerEntityId: 'did:key:owner' }));
  return exec;
};

const tables = (exec: SqlExecutor) =>
  exec.all<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table'`).length;

/** The error a call throws, or undefined when it returns. */
const thrown = (fn: () => unknown): unknown => {
  try {
    fn();
    return undefined;
  } catch (e) {
    return e;
  }
};

describe('readStoredIdentity', () => {
  test('is null for a database holding no store', () => {
    expect(readStoredIdentity(empty(), 'here')).toBeNull();
  });

  test('reads back the identity a create wrote', () => {
    expect(readStoredIdentity(created(), 'here')).toEqual({ ownerEntityId: 'did:key:owner' });
  });

  test.each([
    ['another version', 'UPDATE format SET version = 2', 2],
    ['no version', 'DELETE FROM format', undefined],
  ] as const)('refuses a store naming %s, writing nothing', (_name, sql, actual) => {
    const exec = created();
    exec.exec(sql);
    const before = tables(exec);
    const err = thrown(() => readStoredIdentity(exec, 'here'));
    expect(err).toBeInstanceOf(FormatMismatchError);
    expect(err).toMatchObject({ expected: FORMAT_VERSION, actual, where: 'here' });
    expect(tables(exec)).toBe(before);
  });
});

describe('writeNewStore', () => {
  test('returns the identity it wrote, matching what a later read yields', () => {
    const exec = empty();
    const written = writeNewStore(exec, newStoreSeed({ ownerEntityId: 'did:key:owner' }));
    expect(written).toEqual(readStoredIdentity(exec, 'here'));
  });

  // The tables, the format row and _config are one fact: a create failing
  // partway leaves none of the tables it had already made, and a table of
  // the same name already there fails it rather than being adopted.
  test('writes the whole store or none of it', () => {
    const exec = empty();
    exec.exec(`CREATE TABLE journal (note TEXT)`);
    expect(() => writeNewStore(exec, newStoreSeed({ ownerEntityId: 'did:key:owner' }))).toThrow(
      /journal already exists/,
    );
    expect(tables(exec)).toBe(1);
  });
});

describe('openStore', () => {
  const seed = newStoreSeed({ ownerEntityId: 'did:key:owner' });

  test.each(['ifMissing', 'exclusive'] as const)(
    'refuses a seed for a database already holding a store, under %s',
    async (mode) => {
      const exec = created();
      await expect(openStore(exec, { where: 'here', mode, wal: false, seed })).rejects.toThrow(
        /already exists/,
      );
    },
  );
});
