import { describe, test, expect } from 'vitest';
import {
  insertConfigRecord,
  readStackConfig,
  tryReadStackConfig,
  type StackConfig,
} from '../src/config.js';
import type { SqlExecutor } from '../src/executor.js';

/**
 * A SqlExecutor over a single nullable row, which is all of storage the
 * config functions touch: one INSERT and one SELECT of the `_config`
 * record's content. Keeping it this narrow lets these tests run with no
 * SQLite binding at all — the engines' own suites cover the real SQL.
 */
const stubExecutor = (): SqlExecutor & { row: { content: string } | undefined } => ({
  row: undefined as { content: string } | undefined,
  exec() {},
  run(_sql, params = []) {
    this.row = { content: params[2] as string };
    return 1;
  },
  get<T>() {
    return this.row as T | undefined;
  },
  all<T>() {
    return [] as T[];
  },
  transaction<T>(fn: () => T) {
    return fn();
  },
});

describe('tryReadStackConfig', () => {
  test('returns null when the database has no config record', () => {
    expect(tryReadStackConfig(stubExecutor())).toBeNull();
  });

  test('returns the stored config once one is written', () => {
    const exec = stubExecutor();
    insertConfigRecord(exec, 'did:key:owner', 'America/New_York');
    expect(tryReadStackConfig(exec)).toEqual({
      entityId: 'did:key:owner',
      timezone: 'America/New_York',
    });
  });

  test('reports an absent timezone as undefined rather than omitting it', () => {
    const exec = stubExecutor();
    insertConfigRecord(exec, 'did:key:owner', undefined);
    const config = tryReadStackConfig(exec) as StackConfig;
    expect(config.timezone).toBeUndefined();
    expect('timezone' in config).toBe(true);
  });
});

describe('insertConfigRecord', () => {
  test('returns the config it wrote, matching what a later read yields', () => {
    const exec = stubExecutor();
    const written = insertConfigRecord(exec, 'did:key:owner', 'UTC');
    expect(written).toEqual({ entityId: 'did:key:owner', timezone: 'UTC' });
    expect(written).toEqual(tryReadStackConfig(exec));
  });
});

describe('readStackConfig', () => {
  test('throws when the database has no config record', () => {
    expect(() => readStackConfig(stubExecutor())).toThrow(/missing its config record/);
  });
});
