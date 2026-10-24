/**
 * Pins docs/spec/portability.md § Columns to the schema a new store is
 * created with: the portable format is specified so a reader needs no tool,
 * which holds only while the spec and the database agree.
 */
import { test, expect, afterEach } from 'vitest';
import { mkdirSync, readFileSync, rmSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { DatabaseSync } from '../src/node-sqlite.js';
import { NativeSQLiteRecordAdapter } from '../src/index.js';

const SPEC = resolve(__dirname, '../../../docs/spec/portability.md');

/** The `### Columns` table, as table name to column names. */
function documentedColumns(): Record<string, string[]> {
  const spec = readFileSync(SPEC, 'utf8');
  const section = spec.slice(spec.indexOf('### Columns')).split(/\n#{2,3} /)[0];
  const tables: Record<string, string[]> = {};
  for (const [, table, columns] of section.matchAll(/^\| `(\w+)` +\| (.+?) +\|$/gm)) {
    tables[table] = [...columns.matchAll(/`(\w+)`/g)].map(([, column]) => column);
  }
  return tables;
}

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

test('every table and column a new store holds is the one the spec documents, at format version 1', async () => {
  dir = join(tmpdir(), `portable-format-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'stack.db');
  const adapter = await NativeSQLiteRecordAdapter.open({
    path,
    create: 'exclusive',
    ownerEntityId: 'did:key:portable-format',
  });
  await adapter.close();

  const db = new DatabaseSync(path);
  // records_fts and its shadow tables belong to FTS5; see § Columns.
  const tables = (
    db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table'
           AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'records_fts%'`,
      )
      .all() as { name: string }[]
  ).map(({ name }) => name);
  const actual = Object.fromEntries(
    tables.map((table) => [
      table,
      (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name),
    ]),
  );
  const format = db.prepare('SELECT version FROM format').all();
  db.close();

  expect(actual).toEqual(documentedColumns());
  expect(format).toEqual([{ version: 1 }]);
});
