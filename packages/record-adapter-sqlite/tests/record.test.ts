import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, existsSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { DatabaseSync } from '../src/node-sqlite.js';
import { NativeSQLiteRecordAdapter } from '../src/index.js';
import {
  StackConflictError,
  StackVersionConflictError,
  StackNotFoundError,
  StackQueryError,
} from '@haverstack/core';
import type { StackRecord } from '@haverstack/core';

// -------------------------------------------------------
// Test helpers
// -------------------------------------------------------

let testDir: string;
let dbPath: string;

beforeEach(() => {
  testDir = join(tmpdir(), `sqlite-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(testDir, { recursive: true });
  dbPath = join(testDir, 'test.db');
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

const initAdapter = (opts?: { timezone?: string; entityId?: string }) =>
  NativeSQLiteRecordAdapter.initialize({
    path: dbPath,
    entityId: opts?.entityId ?? 'entity-123',
    timezone: opts?.timezone ?? 'America/New_York',
  });

const NOTE_TYPE = {
  id: 'com.example.test/note@1',
  baseId: 'com.example.test/note',
  version: 1,
  name: 'Note',
  schema: { text: { kind: 'text' as const, required: true } },
  schemaHash: 'abc123',
  createdAt: new Date(),
};

const makeRecord = (overrides: Partial<StackRecord> = {}): StackRecord => ({
  id: `rec-${Math.random().toString(36).slice(2)}`,
  typeId: 'com.example.test/note@1',
  createdAt: new Date(),
  updatedAt: new Date(),
  content: { text: 'Hello world' },
  version: 1,
  ...overrides,
});

// -------------------------------------------------------
// initialize / open
// -------------------------------------------------------

describe('initialize', () => {
  test('creates a new database file', async () => {
    await initAdapter();
    expect(existsSync(dbPath)).toBe(true);
  });

  test('sets ownerEntityId', async () => {
    const adapter = await initAdapter({ entityId: 'owner-abc' });
    expect(adapter.ownerEntityId).toBe('owner-abc');
  });

  test('sets timezone', async () => {
    const adapter = await initAdapter({ timezone: 'Europe/London' });
    expect(adapter.timezone).toBe('Europe/London');
  });

  test('throws if database already exists', async () => {
    await initAdapter();
    await expect(initAdapter()).rejects.toThrow(/already exists/);
  });

  test('enables WAL journal mode', async () => {
    await initAdapter();
    const db = new DatabaseSync(dbPath);
    const mode = db.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
    expect(mode.journal_mode).toBe('wal');
    db.close();
  });
});

describe('open', () => {
  test('opens an existing database', async () => {
    await initAdapter();
    const adapter = await NativeSQLiteRecordAdapter.open({ path: dbPath });
    expect(adapter.ownerEntityId).toBe('entity-123');
  });

  test('throws if database does not exist', async () => {
    await expect(
      NativeSQLiteRecordAdapter.open({ path: join(testDir, 'nonexistent.db') }),
    ).rejects.toThrow(/no database found/);
  });

  test('data persists across adapter instances (no explicit flush needed)', async () => {
    const adapter1 = await initAdapter();
    await adapter1.saveType(NOTE_TYPE);
    const record = makeRecord();
    await adapter1.createRecord(record);

    const adapter2 = await NativeSQLiteRecordAdapter.open({ path: dbPath });
    expect(await adapter2.getType(NOTE_TYPE.id)).not.toBeNull();
    expect(await adapter2.getRecord(record.id)).not.toBeNull();
  });
});

test('preserves ownerEntityId and timezone across reopen', async () => {
  await initAdapter({ entityId: 'owner-abc', timezone: 'Europe/London' });
  const adapter = await NativeSQLiteRecordAdapter.open({ path: dbPath });
  expect(adapter.ownerEntityId).toBe('owner-abc');
  expect(adapter.timezone).toBe('Europe/London');
});

// -------------------------------------------------------
// Storage ownership lock
// -------------------------------------------------------

describe('storage ownership lock', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('open() rejects when a live process already holds the lock', async () => {
    await initAdapter();
    const otherPid = process.pid + 1;
    writeFileSync(`${dbPath}.lock`, JSON.stringify({ pid: otherPid }));
    vi.spyOn(process, 'kill').mockImplementation(() => true);

    await expect(NativeSQLiteRecordAdapter.open({ path: dbPath })).rejects.toThrow(
      new RegExp(`in use by another process \\(pid ${otherPid}\\)`),
    );
  });

  test('open() reclaims a lock left by a dead process', async () => {
    await initAdapter();
    const deadPid = process.pid + 1;
    writeFileSync(`${dbPath}.lock`, JSON.stringify({ pid: deadPid }));
    vi.spyOn(process, 'kill').mockImplementation(() => {
      const err = new Error('no such process') as NodeJS.ErrnoException;
      err.code = 'ESRCH';
      throw err;
    });

    const adapter = await NativeSQLiteRecordAdapter.open({ path: dbPath });
    expect(adapter.ownerEntityId).toBe('entity-123');
  });

  test('open() with force bypasses a live lock', async () => {
    await initAdapter();
    const otherPid = process.pid + 1;
    writeFileSync(`${dbPath}.lock`, JSON.stringify({ pid: otherPid }));
    vi.spyOn(process, 'kill').mockImplementation(() => true);

    const adapter = await NativeSQLiteRecordAdapter.open({ path: dbPath, force: true });
    expect(adapter.ownerEntityId).toBe('entity-123');
  });

  test('close() releases the lock so a later open() succeeds without force', async () => {
    const adapter = await initAdapter();
    await adapter.close();
    await expect(NativeSQLiteRecordAdapter.open({ path: dbPath })).resolves.toBeDefined();
  });
});

// -------------------------------------------------------
// Cross-compatibility with record-adapter-sqljs files
// -------------------------------------------------------

describe('FTS4 -> FTS5 migration', () => {
  const writeSqljsStyleDb = (path: string) => {
    // Mirrors record-adapter-sqljs's schema shape without depending on
    // that package — a real file created with an FTS4 records_fts table.
    const db = new DatabaseSync(path);
    db.exec(`CREATE TABLE records (
      id TEXT PRIMARY KEY, type_id TEXT NOT NULL, created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL, content TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
      parent_id TEXT, entity_id TEXT, app_id TEXT, deleted_at INTEGER, permissions TEXT
    ) STRICT;`);
    db.exec(`CREATE VIRTUAL TABLE records_fts USING fts4(content, content='records');`);
    const now = Date.now();
    db.prepare(
      `INSERT INTO records (id, type_id, created_at, updated_at, content, version)
       VALUES ('_config', '_config@1', ?, ?, ?, 1)`,
    ).run(now, now, JSON.stringify({ entityId: 'entity-123', timezone: 'UTC' }));
    db.prepare(
      `INSERT INTO records (id, type_id, created_at, updated_at, content, version) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      'r1',
      'com.example.test/note@1',
      now,
      now,
      JSON.stringify({ text: 'hello from sqljs' }),
      1,
    );
    db.prepare(
      `INSERT INTO records_fts(docid, content) SELECT rowid, content FROM records WHERE id = 'r1'`,
    ).run();
    db.close();
  };

  test('open() transparently migrates an FTS4 file to FTS5', async () => {
    writeSqljsStyleDb(dbPath);
    const adapter = await NativeSQLiteRecordAdapter.open({ path: dbPath });
    expect(adapter.ownerEntityId).toBe('entity-123');

    const result = await adapter.queryRecords({ filter: { search: 'hello' } });
    expect(result.records.map((r) => r.id)).toEqual(['r1']);

    const db = new DatabaseSync(dbPath);
    const ftsSql = db.prepare(`SELECT sql FROM sqlite_master WHERE name = 'records_fts'`).get() as {
      sql: string;
    };
    expect(ftsSql.sql.toLowerCase()).toContain('fts5');
    db.close();
  });

  test('migration is idempotent — reopening an already-migrated file is a no-op', async () => {
    writeSqljsStyleDb(dbPath);
    const adapter1 = await NativeSQLiteRecordAdapter.open({ path: dbPath });
    await adapter1.close();

    const adapter2 = await NativeSQLiteRecordAdapter.open({ path: dbPath, force: true });
    const result = await adapter2.queryRecords({ filter: { search: 'hello' } });
    expect(result.records.map((r) => r.id)).toEqual(['r1']);
  });
});

// -------------------------------------------------------
// Types
// -------------------------------------------------------

describe('types', () => {
  test('saveType and getType roundtrip', async () => {
    const adapter = await initAdapter();
    await adapter.saveType(NOTE_TYPE);
    const retrieved = await adapter.getType(NOTE_TYPE.id);
    expect(retrieved?.id).toBe(NOTE_TYPE.id);
    expect(retrieved?.name).toBe(NOTE_TYPE.name);
    expect(retrieved?.schema).toEqual(NOTE_TYPE.schema);
    expect(retrieved?.schemaHash).toBe(NOTE_TYPE.schemaHash);
    expect(retrieved?.createdAt).toBeInstanceOf(Date);
  });

  test('getType returns null for unknown id', async () => {
    const adapter = await initAdapter();
    expect(await adapter.getType('com.example/unknown@1')).toBeNull();
  });

  test('listTypes returns all saved types', async () => {
    const adapter = await initAdapter();
    const typeB = { ...NOTE_TYPE, id: 'com.example.test/note@2', version: 2 };
    await adapter.saveType(NOTE_TYPE);
    await adapter.saveType(typeB);
    const types = await adapter.listTypes();
    expect(types.length).toBe(2);
    expect(types.map((t) => t.id)).toContain(NOTE_TYPE.id);
    expect(types.map((t) => t.id)).toContain(typeB.id);
  });

  test('saveType with migratesFrom stores lineage', async () => {
    const adapter = await initAdapter();
    const typeV2 = {
      ...NOTE_TYPE,
      id: 'com.example.test/note@2',
      version: 2,
      migratesFrom: NOTE_TYPE.id,
    };
    await adapter.saveType(typeV2);
    const retrieved = await adapter.getType(typeV2.id);
    expect(retrieved?.migratesFrom).toBe(NOTE_TYPE.id);
  });

  test('saveType overwrites existing type with same id', async () => {
    const adapter = await initAdapter();
    await adapter.saveType(NOTE_TYPE);
    const updated = { ...NOTE_TYPE, name: 'Updated Note' };
    await adapter.saveType(updated);
    const retrieved = await adapter.getType(NOTE_TYPE.id);
    expect(retrieved?.name).toBe('Updated Note');
  });
});

// -------------------------------------------------------
// Records — CRUD
// -------------------------------------------------------

describe('records — CRUD', () => {
  test('createRecord and getRecord roundtrip', async () => {
    const adapter = await initAdapter();
    const record = makeRecord({ content: { text: 'Hello' } });
    await adapter.createRecord(record);
    const retrieved = await adapter.getRecord(record.id);
    expect(retrieved?.id).toBe(record.id);
    expect(retrieved?.content).toEqual({ text: 'Hello' });
    expect(retrieved?.createdAt).toBeInstanceOf(Date);
    expect(retrieved?.updatedAt).toBeInstanceOf(Date);
  });

  test('getRecord returns null for unknown id', async () => {
    const adapter = await initAdapter();
    expect(await adapter.getRecord('nonexistent')).toBeNull();
  });

  test('createRecord stores optional native fields', async () => {
    const adapter = await initAdapter();
    const record = makeRecord({
      parentId: 'parent-abc',
      entityId: 'entity-xyz',
      appId: 'app-123',
    });
    await adapter.createRecord(record);
    const retrieved = await adapter.getRecord(record.id);
    expect(retrieved?.parentId).toBe('parent-abc');
    expect(retrieved?.entityId).toBe('entity-xyz');
    expect(retrieved?.appId).toBe('app-123');
  });

  test('createRecord throws StackConflictError on a duplicate id instead of an unmapped engine error', async () => {
    const adapter = await initAdapter();
    const record = makeRecord();
    await adapter.createRecord(record);
    await expect(adapter.createRecord({ ...record, content: { text: 'second' } })).rejects.toThrow(
      StackConflictError,
    );
    const retrieved = await adapter.getRecord(record.id);
    expect(retrieved?.content).toEqual({ text: 'Hello world' });
  });

  test('patchContent changes content and bumps version', async () => {
    const adapter = await initAdapter();
    const record = makeRecord();
    await adapter.createRecord(record);
    const updated = await adapter.patchContent(record.id, { text: 'Updated' });
    expect(updated.content).toEqual({ text: 'Updated' });
    expect(updated.version).toBe(2);
  });

  test('patchContent preserves unchanged fields', async () => {
    const adapter = await initAdapter();
    const record = makeRecord({ parentId: 'parent-abc' });
    await adapter.createRecord(record);
    await adapter.patchContent(record.id, { text: 'Updated' });
    const retrieved = await adapter.getRecord(record.id);
    expect(retrieved?.parentId).toBe('parent-abc');
  });

  test('soft deleteRecord sets deletedAt', async () => {
    const adapter = await initAdapter();
    const record = makeRecord();
    await adapter.createRecord(record);
    await adapter.deleteRecord(record.id);
    const retrieved = await adapter.getRecord(record.id);
    expect(retrieved?.deletedAt).toBeInstanceOf(Date);
  });

  test('hard deleteRecord removes record entirely', async () => {
    const adapter = await initAdapter();
    const record = makeRecord();
    await adapter.createRecord(record);
    await adapter.deleteRecord(record.id, { hard: true });
    expect(await adapter.getRecord(record.id)).toBeNull();
  });

  test('hard deleteRecord removes version history', async () => {
    const adapter = await initAdapter();
    const record = makeRecord();
    await adapter.createRecord(record);
    await adapter.saveVersion(record.id, {
      version: 1,
      typeId: record.typeId,
      content: record.content,
      updatedAt: record.updatedAt,
    });
    await adapter.deleteRecord(record.id, { hard: true });
    expect(await adapter.getVersions(record.id)).toEqual([]);
  });

  test('undeleteRecord clears deletedAt and returns the record', async () => {
    const adapter = await initAdapter();
    const record = makeRecord();
    await adapter.createRecord(record);
    await adapter.deleteRecord(record.id);

    const undeleted = await adapter.undeleteRecord(record.id);
    expect(undeleted.deletedAt).toBeUndefined();

    const retrieved = await adapter.getRecord(record.id);
    expect(retrieved?.deletedAt).toBeUndefined();
  });

  test('stored dates roundtrip correctly', async () => {
    const adapter = await initAdapter();
    const createdAt = new Date('2024-06-15T12:00:00.000Z');
    const record = makeRecord({ createdAt });
    await adapter.createRecord(record);
    const retrieved = await adapter.getRecord(record.id);
    expect(retrieved?.createdAt.getTime()).toBe(createdAt.getTime());
  });
});

// -------------------------------------------------------
// expectedVersion (opt-in optimistic concurrency)
// -------------------------------------------------------

describe('expectedVersion', () => {
  test('patchContent applies when expectedVersion matches', async () => {
    const adapter = await initAdapter();
    const record = await adapter.createRecord(makeRecord());
    const updated = await adapter.patchContent(
      record.id,
      { text: 'Updated' },
      { expectedVersion: 1 },
    );
    expect(updated.version).toBe(2);
    expect(updated.content).toEqual({ text: 'Updated' });
  });

  test('patchContent throws StackVersionConflictError and changes nothing when stale', async () => {
    const adapter = await initAdapter();
    const record = await adapter.createRecord(makeRecord());
    await adapter.patchContent(record.id, { text: 'first' }); // -> v2

    const err = await adapter
      .patchContent(record.id, { text: 'second' }, { expectedVersion: 1 })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StackVersionConflictError);
    expect((err as StackVersionConflictError).recordId).toBe(record.id);
    expect((err as StackVersionConflictError).expectedVersion).toBe(1);
    expect((err as StackVersionConflictError).actualVersion).toBe(2);

    const current = await adapter.getRecord(record.id);
    expect(current?.version).toBe(2);
    expect(current?.content).toEqual({ text: 'first' });
  });

  test('a rejected patchContent leaves the FTS index consistent with stored content', async () => {
    const adapter = await initAdapter();
    const record = await adapter.createRecord(
      makeRecord({ content: { text: 'searchable original' } }),
    );
    await adapter
      .patchContent(record.id, { text: 'rejected update' }, { expectedVersion: 999 })
      .catch(() => {});

    const stillFindsOriginal = await adapter.queryRecords({ filter: { search: 'original' } });
    expect(stillFindsOriginal.records.map((r) => r.id)).toEqual([record.id]);
    const doesNotFindRejected = await adapter.queryRecords({ filter: { search: 'rejected' } });
    expect(doesNotFindRejected.records).toEqual([]);
  });

  test('soft deleteRecord and undeleteRecord enforce expectedVersion', async () => {
    const adapter = await initAdapter();
    const record = await adapter.createRecord(makeRecord());
    await adapter.patchContent(record.id, { text: 'v2' }); // -> v2

    await expect(adapter.deleteRecord(record.id, { expectedVersion: 1 })).rejects.toBeInstanceOf(
      StackVersionConflictError,
    );
    await adapter.deleteRecord(record.id, { expectedVersion: 2 }); // -> v3

    await expect(adapter.undeleteRecord(record.id, { expectedVersion: 1 })).rejects.toBeInstanceOf(
      StackVersionConflictError,
    );
    const undeleted = await adapter.undeleteRecord(record.id, { expectedVersion: 3 }); // -> v4
    expect(undeleted.version).toBe(4);
  });

  test('hard deleteRecord enforces expectedVersion and leaves the record untouched on mismatch', async () => {
    const adapter = await initAdapter();
    const record = await adapter.createRecord(makeRecord());
    await adapter.patchContent(record.id, { text: 'v2' }); // -> v2

    await expect(
      adapter.deleteRecord(record.id, { hard: true, expectedVersion: 1 }),
    ).rejects.toBeInstanceOf(StackVersionConflictError);
    expect(await adapter.getRecord(record.id)).not.toBeNull();

    await adapter.deleteRecord(record.id, { hard: true, expectedVersion: 2 });
    expect(await adapter.getRecord(record.id)).toBeNull();
  });

  test('associate and dissociate enforce expectedVersion', async () => {
    const adapter = await initAdapter();
    const record = await adapter.createRecord(makeRecord());

    await expect(
      adapter.associate(record.id, { kind: 'tag', label: 'x' }, { expectedVersion: 99 }),
    ).rejects.toBeInstanceOf(StackVersionConflictError);

    await adapter.associate(record.id, { kind: 'tag', label: 'x' }, { expectedVersion: 1 }); // -> v2

    await expect(
      adapter.dissociate(record.id, { kind: 'tag', label: 'x' }, { expectedVersion: 1 }),
    ).rejects.toBeInstanceOf(StackVersionConflictError);
    await adapter.dissociate(record.id, { kind: 'tag', label: 'x' }, { expectedVersion: 2 }); // -> v3

    expect((await adapter.getRecord(record.id))?.version).toBe(3);
  });

  test('setPermissions enforces expectedVersion', async () => {
    const adapter = await initAdapter();
    const record = await adapter.createRecord(makeRecord());

    await expect(
      adapter.setPermissions(record.id, [{ access: 'public' }], { expectedVersion: 99 }),
    ).rejects.toBeInstanceOf(StackVersionConflictError);

    await adapter.setPermissions(record.id, [{ access: 'public' }], { expectedVersion: 1 });
    expect((await adapter.getRecord(record.id))?.version).toBe(2);
  });

  test('restoreVersion enforces expectedVersion', async () => {
    const adapter = await initAdapter();
    const record = await adapter.createRecord(makeRecord({ content: { text: 'original' } }));
    await adapter.saveVersion(record.id, {
      version: 1,
      typeId: record.typeId,
      content: { text: 'original' },
      updatedAt: record.updatedAt,
    });
    await adapter.patchContent(record.id, { text: 'v2' }); // -> v2

    await expect(
      adapter.restoreVersion(record.id, 1, { expectedVersion: 1 }),
    ).rejects.toBeInstanceOf(StackVersionConflictError);

    const restored = await adapter.restoreVersion(record.id, 1, { expectedVersion: 2 }); // -> v3
    expect(restored.version).toBe(3);
    expect(restored.content).toEqual({ text: 'original' });
  });

  test('expectedVersion on a nonexistent record throws StackNotFoundError', async () => {
    const adapter = await initAdapter();
    await expect(
      adapter.associate('nonexistent', { kind: 'tag', label: 'x' }, { expectedVersion: 1 }),
    ).rejects.toThrow(StackNotFoundError);
  });
});

// -------------------------------------------------------
// Records — queries
// -------------------------------------------------------

describe('records — queries', () => {
  test('queryRecords returns all non-deleted records by default', async () => {
    const adapter = await initAdapter();
    const r1 = makeRecord({ id: 'r1' });
    const r2 = makeRecord({ id: 'r2' });
    const r3 = makeRecord({ id: 'r3' });
    await adapter.createRecord(r1);
    await adapter.createRecord(r2);
    await adapter.createRecord(r3);
    await adapter.deleteRecord(r3.id);
    const result = await adapter.queryRecords({});
    expect(result.records.length).toBe(2);
    expect(result.total).toBe(2);
  });

  test('includeDeleted returns soft-deleted records', async () => {
    const adapter = await initAdapter();
    const record = makeRecord();
    await adapter.createRecord(record);
    await adapter.deleteRecord(record.id);
    const result = await adapter.queryRecords({ filter: { includeDeleted: true } });
    expect(result.records.some((r) => r.id === record.id)).toBe(true);
  });

  test('filters by typeId', async () => {
    const adapter = await initAdapter();
    const noteType = makeRecord({ typeId: 'com.example/note@1' });
    const taskType = makeRecord({ typeId: 'com.example/task@1' });
    await adapter.createRecord(noteType);
    await adapter.createRecord(taskType);
    const result = await adapter.queryRecords({ filter: { typeId: 'com.example/note@1' } });
    expect(result.records.every((r) => r.typeId === 'com.example/note@1')).toBe(true);
    expect(result.records.length).toBe(1);
  });

  test('filters by parentId', async () => {
    const adapter = await initAdapter();
    const parent = makeRecord({ id: 'parent' });
    const child1 = makeRecord({ id: 'child1', parentId: 'parent' });
    const other = makeRecord({ id: 'other' });
    await adapter.createRecord(parent);
    await adapter.createRecord(child1);
    await adapter.createRecord(other);
    const result = await adapter.queryRecords({ filter: { parentId: 'parent' } });
    expect(result.records.length).toBe(1);
    expect(result.records[0].parentId).toBe('parent');
  });

  test('filters by content field', async () => {
    const adapter = await initAdapter();
    await adapter.createRecord(makeRecord({ id: 'r1', content: { text: 'alpha', priority: 1 } }));
    await adapter.createRecord(makeRecord({ id: 'r2', content: { text: 'beta', priority: 2 } }));
    const result = await adapter.queryRecords({ filter: { content: { priority: 1 } } });
    expect(result.records.length).toBe(1);
    expect(result.records[0].id).toBe('r1');
  });

  // #69: a null content filter means "field absent or null," never "match
  // nothing" — plain SQL `= NULL` is always false, which used to make this
  // silently return zero records with no signal.
  test('content filter with a null value matches records where the field is absent', async () => {
    const adapter = await initAdapter();
    await adapter.createRecord(makeRecord({ id: 'r1', content: { text: 'no priority set' } }));
    await adapter.createRecord(makeRecord({ id: 'r2', content: { text: 'has one', priority: 1 } }));
    const result = await adapter.queryRecords({ filter: { content: { priority: null } } });
    expect(result.records.length).toBe(1);
    expect(result.records[0].id).toBe('r1');
  });

  test('content filter with a null value matches records where the field is stored as null', async () => {
    const adapter = await initAdapter();
    await adapter.createRecord(
      makeRecord({ id: 'r1', content: { text: 'explicit null', priority: null } }),
    );
    await adapter.createRecord(makeRecord({ id: 'r2', content: { text: 'has one', priority: 1 } }));
    const result = await adapter.queryRecords({ filter: { content: { priority: null } } });
    expect(result.records.length).toBe(1);
    expect(result.records[0].id).toBe('r1');
  });

  test('full-text search (FTS5)', async () => {
    const adapter = await initAdapter();
    await adapter.createRecord(makeRecord({ id: 'r1', content: { text: 'SQLite is great' } }));
    await adapter.createRecord(
      makeRecord({ id: 'r2', content: { text: 'Postgres is also great' } }),
    );
    const result = await adapter.queryRecords({ filter: { search: 'SQLite' } });
    expect(result.records.length).toBe(1);
    expect(result.records[0].id).toBe('r1');
  });

  test('full-text search reflects patchContent updates (not stale index entries)', async () => {
    const adapter = await initAdapter();
    const record = makeRecord({ content: { text: 'original content here' } });
    await adapter.createRecord(record);
    await adapter.patchContent(record.id, { text: 'updated content here' });

    const staleSearch = await adapter.queryRecords({ filter: { search: 'original' } });
    expect(staleSearch.records).toEqual([]);
    const freshSearch = await adapter.queryRecords({ filter: { search: 'updated' } });
    expect(freshSearch.records.map((r) => r.id)).toEqual([record.id]);
  });

  test('full-text search no longer finds hard-deleted records', async () => {
    const adapter = await initAdapter();
    const record = makeRecord({ content: { text: 'findme unique token' } });
    await adapter.createRecord(record);
    await adapter.deleteRecord(record.id, { hard: true });

    const result = await adapter.queryRecords({ filter: { search: 'findme' } });
    expect(result.records).toEqual([]);
  });

  test('cursor pagination returns correct pages', async () => {
    const adapter = await initAdapter();
    for (let i = 0; i < 5; i++) {
      await adapter.createRecord(
        makeRecord({ id: `r${i}`, createdAt: new Date(Date.now() + i * 1000) }),
      );
    }
    const page1 = await adapter.queryRecords({
      sort: { field: 'createdAt', direction: 'asc' },
      limit: 3,
    });
    expect(page1.records.length).toBe(3);
    expect(page1.cursor).not.toBeNull();
    expect(page1.total).toBe(5);

    const page2 = await adapter.queryRecords({
      sort: { field: 'createdAt', direction: 'asc' },
      limit: 3,
      cursor: page1.cursor!,
    });
    expect(page2.records.length).toBe(2);
    expect(page2.cursor).toBeNull();
  });

  test('malformed cursor throws StackQueryError', async () => {
    const adapter = await initAdapter();
    await adapter.createRecord(makeRecord({ id: 'r1' }));
    await expect(adapter.queryRecords({ cursor: '!!!not-a-cursor!!!' })).rejects.toThrow(
      StackQueryError,
    );
  });

  test('cursor minted under one sort field replayed with a different sort field throws StackQueryError', async () => {
    const adapter = await initAdapter();
    for (let i = 0; i < 5; i++) {
      await adapter.createRecord(makeRecord({ id: `r${i}`, createdAt: new Date(i * 1000) }));
    }
    const page1 = await adapter.queryRecords({
      sort: { field: 'createdAt', direction: 'asc' },
      limit: 3,
    });
    expect(page1.cursor).not.toBeNull();

    await expect(
      adapter.queryRecords({
        sort: { field: 'version', direction: 'asc' },
        limit: 3,
        cursor: page1.cursor!,
      }),
    ).rejects.toThrow(StackQueryError);
  });

  test('sort by createdAt descending (default)', async () => {
    const adapter = await initAdapter();
    await adapter.createRecord(makeRecord({ id: 'r1', createdAt: new Date(1000) }));
    await adapter.createRecord(makeRecord({ id: 'r2', createdAt: new Date(2000) }));
    await adapter.createRecord(makeRecord({ id: 'r3', createdAt: new Date(3000) }));
    const result = await adapter.queryRecords({ sort: { field: 'createdAt', direction: 'desc' } });
    expect(result.records.map((r) => r.id)).toEqual(['r3', 'r2', 'r1']);
  });
});

// -------------------------------------------------------
// file-ref indexing (#63)
// -------------------------------------------------------

describe('file-ref indexing', () => {
  const FILE_REF_TYPE = {
    id: 'com.example.test/photo-note@1',
    baseId: 'com.example.test/photo-note',
    version: 1,
    name: 'Photo note',
    schema: { coverFileId: { kind: 'file-ref' as const, required: true } },
    schemaHash: 'abc123',
    createdAt: new Date(),
  };

  const STRING_TYPE = {
    id: 'com.example.test/photo-note-plain@1',
    baseId: 'com.example.test/photo-note-plain',
    version: 1,
    name: 'Photo note (plain)',
    schema: { coverFileId: { kind: 'string' as const, required: true } },
    schemaHash: 'def456',
    createdAt: new Date(),
  };

  test('attachmentFileId filter matches a record via a top-level file-ref field', async () => {
    const adapter = await initAdapter();
    await adapter.saveType(FILE_REF_TYPE);
    await adapter.createRecord(
      makeRecord({ id: 'r1', typeId: FILE_REF_TYPE.id, content: { coverFileId: 'file-1' } }),
    );

    const result = await adapter.queryRecords({ filter: { attachmentFileId: 'file-1' } });
    expect(result.records.map((r) => r.id)).toEqual(['r1']);
  });

  test('attachmentFileId filter does not match a plain string field holding the same value', async () => {
    const adapter = await initAdapter();
    await adapter.saveType(STRING_TYPE);
    await adapter.createRecord(
      makeRecord({ id: 'r1', typeId: STRING_TYPE.id, content: { coverFileId: 'file-1' } }),
    );

    const result = await adapter.queryRecords({ filter: { attachmentFileId: 'file-1' } });
    expect(result.records).toEqual([]);
  });

  test('patchContent that changes the file-ref value updates the index', async () => {
    const adapter = await initAdapter();
    await adapter.saveType(FILE_REF_TYPE);
    const record = makeRecord({
      id: 'r1',
      typeId: FILE_REF_TYPE.id,
      content: { coverFileId: 'file-1' },
    });
    await adapter.createRecord(record);
    await adapter.patchContent('r1', { coverFileId: 'file-2' });

    const oldMatch = await adapter.queryRecords({ filter: { attachmentFileId: 'file-1' } });
    expect(oldMatch.records).toEqual([]);
    const newMatch = await adapter.queryRecords({ filter: { attachmentFileId: 'file-2' } });
    expect(newMatch.records.map((r) => r.id)).toEqual(['r1']);
  });

  test('hard delete removes the record from file-ref matching', async () => {
    const adapter = await initAdapter();
    await adapter.saveType(FILE_REF_TYPE);
    await adapter.createRecord(
      makeRecord({ id: 'r1', typeId: FILE_REF_TYPE.id, content: { coverFileId: 'file-1' } }),
    );
    await adapter.deleteRecord('r1', { hard: true });

    const result = await adapter.queryRecords({ filter: { attachmentFileId: 'file-1' } });
    expect(result.records).toEqual([]);
  });

  test('deleteUnreferencedAttachmentRecords is blocked by a content-held file-ref field', async () => {
    const adapter = await initAdapter();
    const ATTACHMENT_TYPE = 'com.example.test/_attachment@1';
    await adapter.saveType(FILE_REF_TYPE);
    await adapter.createRecord(
      makeRecord({ id: 'meta1', typeId: ATTACHMENT_TYPE, content: { fileId: 'file-1' } }),
    );
    await adapter.createRecord(
      makeRecord({ id: 'r1', typeId: FILE_REF_TYPE.id, content: { coverFileId: 'file-1' } }),
    );

    await expect(
      adapter.deleteUnreferencedAttachmentRecords('file-1', ATTACHMENT_TYPE),
    ).rejects.toThrow(StackConflictError);
    expect(await adapter.getRecord('meta1')).not.toBeNull();
  });

  // File-ref field names are cached per typeId (keyed off saveType()) so that
  // syncFileRefs() doesn't re-query and re-parse the schema on every write —
  // this guards against that cache going stale if a type is redefined.
  test('redefining a type via saveType updates which fields are treated as file-ref', async () => {
    const adapter = await initAdapter();
    await adapter.saveType(FILE_REF_TYPE);
    await adapter.createRecord(
      makeRecord({ id: 'r1', typeId: FILE_REF_TYPE.id, content: { coverFileId: 'file-1' } }),
    );
    let result = await adapter.queryRecords({ filter: { attachmentFileId: 'file-1' } });
    expect(result.records.map((r) => r.id)).toEqual(['r1']);

    // Redefine the same typeId so coverFileId is no longer a file-ref field.
    await adapter.saveType({ ...FILE_REF_TYPE, schema: STRING_TYPE.schema });
    await adapter.patchContent('r1', { coverFileId: 'file-1' });

    result = await adapter.queryRecords({ filter: { attachmentFileId: 'file-1' } });
    expect(result.records).toEqual([]);
  });

  // A cold adapter has an empty in-memory cache even though the `types`
  // table already has the schema on disk — the lazy-fill fallback in
  // getFileRefFields() must still find it.
  test('indexes file-ref fields for a type saved before this adapter instance existed', async () => {
    const first = await initAdapter();
    await first.saveType(FILE_REF_TYPE);

    const reopened = await NativeSQLiteRecordAdapter.open({ path: dbPath });
    await reopened.createRecord(
      makeRecord({ id: 'r1', typeId: FILE_REF_TYPE.id, content: { coverFileId: 'file-1' } }),
    );

    const result = await reopened.queryRecords({ filter: { attachmentFileId: 'file-1' } });
    expect(result.records.map((r) => r.id)).toEqual(['r1']);
  });
});

// -------------------------------------------------------
// Associations
// -------------------------------------------------------

describe('associations', () => {
  test('associate adds a tag and it appears on the record', async () => {
    const adapter = await initAdapter();
    const record = makeRecord();
    await adapter.createRecord(record);
    await adapter.associate(record.id, { kind: 'tag', label: 'starred' });
    const retrieved = await adapter.getRecord(record.id);
    expect(retrieved?.associations?.some((a) => a.kind === 'tag' && a.label === 'starred')).toBe(
      true,
    );
  });

  test('dissociate removes a tag', async () => {
    const adapter = await initAdapter();
    const record = makeRecord();
    await adapter.createRecord(record);
    await adapter.associate(record.id, { kind: 'tag', label: 'starred' });
    await adapter.dissociate(record.id, { kind: 'tag', label: 'starred' });
    const retrieved = await adapter.getRecord(record.id);
    const hasStarred = (retrieved?.associations ?? []).some((a) => a.label === 'starred');
    expect(hasStarred).toBe(false);
  });

  test('associate is idempotent — duplicate does not create two entries', async () => {
    const adapter = await initAdapter();
    const record = makeRecord();
    await adapter.createRecord(record);
    await adapter.associate(record.id, { kind: 'tag', label: 'starred' });
    await adapter.associate(record.id, { kind: 'tag', label: 'starred' });
    const retrieved = await adapter.getRecord(record.id);
    const stars = retrieved?.associations?.filter((a) => a.kind === 'tag' && a.label === 'starred');
    expect(stars?.length).toBe(1);
  });

  test('associate bumps version', async () => {
    const adapter = await initAdapter();
    const record = makeRecord();
    await adapter.createRecord(record);
    await adapter.associate(record.id, { kind: 'tag', label: 'starred' });
    const retrieved = await adapter.getRecord(record.id);
    expect(retrieved?.version).toBe(2);
  });

  test('associate on a nonexistent record throws StackNotFoundError instead of creating an orphan row', async () => {
    const adapter = await initAdapter();
    await expect(
      adapter.associate('does-not-exist', { kind: 'tag', label: 'starred' }),
    ).rejects.toThrow(StackNotFoundError);
  });
});

// -------------------------------------------------------
// Permissions
// -------------------------------------------------------

describe('setPermissions', () => {
  test('replaces permissions and bumps version', async () => {
    const adapter = await initAdapter();
    const record = makeRecord();
    await adapter.createRecord(record);
    await adapter.setPermissions(record.id, [{ access: 'public' }]);
    const retrieved = await adapter.getRecord(record.id);
    expect(retrieved?.permissions).toEqual([{ access: 'public' }]);
    expect(retrieved?.version).toBe(2);
  });
});

// -------------------------------------------------------
// Versions
// -------------------------------------------------------

describe('versions', () => {
  test('saveVersion and getVersion roundtrip', async () => {
    const adapter = await initAdapter();
    const record = makeRecord();
    await adapter.createRecord(record);
    const version = {
      version: 1,
      typeId: record.typeId,
      content: { text: 'original' },
      updatedAt: new Date('2024-01-01'),
      entityId: 'entity-123',
    };
    await adapter.saveVersion(record.id, version);
    const retrieved = await adapter.getVersion(record.id, 1);
    expect(retrieved?.content).toEqual({ text: 'original' });
    expect(retrieved?.entityId).toBe('entity-123');
  });

  test('saveVersion throws on a (record, version) collision instead of silently dropping the snapshot', async () => {
    const adapter = await initAdapter();
    const record = makeRecord();
    await adapter.createRecord(record);
    const v = {
      version: 1,
      typeId: record.typeId,
      content: { text: 'original' },
      updatedAt: new Date(),
    };
    await adapter.saveVersion(record.id, v);
    await expect(adapter.saveVersion(record.id, v)).rejects.toThrow(StackConflictError);
    const versions = await adapter.getVersions(record.id);
    expect(versions.length).toBe(1);
  });
});

describe('restoreVersion', () => {
  test('restores content and bumps version', async () => {
    const adapter = await initAdapter();
    const record = makeRecord();
    await adapter.createRecord(record);
    await adapter.saveVersion(record.id, {
      version: 1,
      typeId: record.typeId,
      content: { text: 'original' },
      updatedAt: new Date(),
    });
    await adapter.patchContent(record.id, { text: 'changed' });

    const restored = await adapter.restoreVersion(record.id, 1);
    expect(restored.content).toEqual({ text: 'original' });
    expect(restored.version).toBe(3);
  });

  test('restored content is searchable and the pre-restore content is not', async () => {
    const adapter = await initAdapter();
    const record = makeRecord({ content: { text: 'original searchable text' } });
    await adapter.createRecord(record);
    await adapter.saveVersion(record.id, {
      version: 1,
      typeId: record.typeId,
      content: { text: 'original searchable text' },
      updatedAt: new Date(),
    });
    await adapter.patchContent(record.id, { text: 'changed unrelated text' });

    await adapter.restoreVersion(record.id, 1);

    const findsOriginal = await adapter.queryRecords({ filter: { search: 'searchable' } });
    expect(findsOriginal.records.map((r) => r.id)).toEqual([record.id]);
    const findsChanged = await adapter.queryRecords({ filter: { search: 'unrelated' } });
    expect(findsChanged.records).toEqual([]);
  });

  test('throws for an unknown version', async () => {
    const adapter = await initAdapter();
    const record = makeRecord();
    await adapter.createRecord(record);
    await expect(adapter.restoreVersion(record.id, 99)).rejects.toThrow();
  });

  test('restores typeId from the snapshot, even when it differs from the record’s current typeId', async () => {
    const adapter = await initAdapter();
    const record = makeRecord({ typeId: 'com.example.test/note@1' });
    await adapter.createRecord(record);
    await adapter.saveVersion(record.id, {
      version: 1,
      typeId: 'com.example.test/note@1',
      content: { text: 'original' },
      updatedAt: new Date(),
    });
    await adapter.commitMigration(record.id, 'com.example.test/note@2', {
      text: 'original',
      pinned: false,
    });

    const restored = await adapter.restoreVersion(record.id, 1);
    expect(restored.typeId).toBe('com.example.test/note@1');
    expect(restored.content).toEqual({ text: 'original' });
  });
});

describe('commitMigration', () => {
  test('changes typeId and content together, and bumps version', async () => {
    const adapter = await initAdapter();
    const record = makeRecord({ typeId: 'com.example.test/note@1' });
    await adapter.createRecord(record);

    const migrated = await adapter.commitMigration(record.id, 'com.example.test/note@2', {
      text: 'Hello world',
      pinned: false,
    });
    expect(migrated.typeId).toBe('com.example.test/note@2');
    expect(migrated.content).toEqual({ text: 'Hello world', pinned: false });
    expect(migrated.version).toBe(2);
  });
});

// -------------------------------------------------------
// deleteUnreferencedAttachmentRecords
// -------------------------------------------------------

describe('deleteUnreferencedAttachmentRecords', () => {
  const ATTACHMENT_TYPE = 'com.example.test/_attachment@1';

  test('throws StackConflictError when a record still references the file', async () => {
    const adapter = await initAdapter();
    const record = makeRecord();
    await adapter.createRecord(record);
    await adapter.associate(record.id, {
      kind: 'attachment',
      label: 'cover',
      fileId: 'file-1',
      mimeType: 'image/png',
    });

    await expect(
      adapter.deleteUnreferencedAttachmentRecords('file-1', ATTACHMENT_TYPE),
    ).rejects.toThrow(StackConflictError);
  });

  test('deletes an unreferenced metadata record and returns its id', async () => {
    const adapter = await initAdapter();
    await adapter.createRecord(
      makeRecord({ id: 'meta1', typeId: ATTACHMENT_TYPE, content: { fileId: 'file-1' } }),
    );

    const deleted = await adapter.deleteUnreferencedAttachmentRecords('file-1', ATTACHMENT_TYPE);
    expect(deleted).toEqual(['meta1']);
    expect(await adapter.getRecord('meta1')).toBeNull();
  });

  test('deletes every metadata record sharing the same fileId (dedup case)', async () => {
    const adapter = await initAdapter();
    await adapter.createRecord(
      makeRecord({ id: 'meta1', typeId: ATTACHMENT_TYPE, content: { fileId: 'shared-file' } }),
    );
    await adapter.createRecord(
      makeRecord({ id: 'meta2', typeId: ATTACHMENT_TYPE, content: { fileId: 'shared-file' } }),
    );

    const deleted = await adapter.deleteUnreferencedAttachmentRecords(
      'shared-file',
      ATTACHMENT_TYPE,
    );
    expect(deleted.sort()).toEqual(['meta1', 'meta2']);
  });

  test('returns an empty array when no metadata records exist for the file', async () => {
    const adapter = await initAdapter();
    const deleted = await adapter.deleteUnreferencedAttachmentRecords(
      'nonexistent-file',
      ATTACHMENT_TYPE,
    );
    expect(deleted).toEqual([]);
  });

  test('rolls back and leaves the metadata record intact when the reference check fails', async () => {
    const adapter = await initAdapter();
    await adapter.createRecord(
      makeRecord({ id: 'meta1', typeId: ATTACHMENT_TYPE, content: { fileId: 'file-1' } }),
    );
    const referencing = makeRecord({ id: 'referencing' });
    await adapter.createRecord(referencing);
    await adapter.associate(referencing.id, {
      kind: 'attachment',
      label: 'cover',
      fileId: 'file-1',
      mimeType: 'image/png',
    });

    await expect(
      adapter.deleteUnreferencedAttachmentRecords('file-1', ATTACHMENT_TYPE),
    ).rejects.toThrow(StackConflictError);
    expect(await adapter.getRecord('meta1')).not.toBeNull();
  });
});

// -------------------------------------------------------
// Lifecycle
// -------------------------------------------------------

describe('flush', () => {
  test('checkpoints the WAL without throwing', async () => {
    const adapter = await initAdapter();
    await adapter.createRecord(makeRecord());
    await expect(adapter.flush()).resolves.toBeUndefined();
  });
});
