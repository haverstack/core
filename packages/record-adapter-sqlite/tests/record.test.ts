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
  StackBadRequestError,
} from '@haverstack/core';
import { FormatMismatchError, OwnerMismatchError, resolveQuery } from '@haverstack/core/adapter';
import type { AuthorityAssociation, RecordVersion, StackRecord } from '@haverstack/core';

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

/**
 * A versions row written behind the adapter's back, through a connection of
 * its own: the state an interrupted write leaves, which no adapter call can.
 */
const plantVersionRow = (recordId: string, v: RecordVersion): void => {
  const db = new DatabaseSync(dbPath);
  db.prepare(
    `INSERT INTO versions (record_id, version, type_id, content, updated_at, updated_by, updated_via)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    recordId,
    v.version,
    v.typeId,
    JSON.stringify(v.content),
    v.updatedAt.getTime(),
    v.updatedBy?.subjectId ?? null,
    v.updatedBy?.principalId ?? null,
  );
  db.close();
};

const initAdapter = (opts?: { timezone?: string; ownerEntityId?: string }) =>
  NativeSQLiteRecordAdapter.open({
    create: 'exclusive',
    path: dbPath,
    ownerEntityId: opts?.ownerEntityId ?? 'entity-123',
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
    const adapter = await initAdapter({ ownerEntityId: 'owner-abc' });
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
  await initAdapter({ ownerEntityId: 'owner-abc', timezone: 'Europe/London' });
  const adapter = await NativeSQLiteRecordAdapter.open({ path: dbPath });
  expect(adapter.ownerEntityId).toBe('owner-abc');
  expect(adapter.timezone).toBe('Europe/London');
});

// -------------------------------------------------------
// create modes and owner checks
// -------------------------------------------------------

describe('open create modes', () => {
  test("'never' (the default) fails on a missing store and opens a present one", async () => {
    await expect(NativeSQLiteRecordAdapter.open({ path: dbPath })).rejects.toThrow(
      /Pass create: 'ifMissing' or 'exclusive'/,
    );
    await initAdapter();
    const adapter = await NativeSQLiteRecordAdapter.open({ path: dbPath, create: 'never' });
    expect(adapter.ownerEntityId).toBe('entity-123');
  });

  test("'ifMissing' creates a missing store and opens a present one", async () => {
    const created = await NativeSQLiteRecordAdapter.open({
      path: dbPath,
      create: 'ifMissing',
      ownerEntityId: 'owner-a',
    });
    expect(created.ownerEntityId).toBe('owner-a');
    await created.saveType(NOTE_TYPE);

    const reopened = await NativeSQLiteRecordAdapter.open({
      path: dbPath,
      create: 'ifMissing',
      ownerEntityId: 'owner-a',
    });
    expect(await reopened.getType(NOTE_TYPE.id)).not.toBeNull();
  });

  test("'exclusive' creates a missing store and fails on a present one", async () => {
    await initAdapter();
    await expect(initAdapter()).rejects.toThrow(/Pass create: 'never' or 'ifMissing'/);
    rmSync(dbPath);
    rmSync(`${dbPath}.lock`, { force: true });
    await expect(initAdapter()).resolves.toBeDefined();
  });

  test.each(['ifMissing', 'exclusive'] as const)(
    "creating under '%s' without an owner fails and leaves no file behind",
    async (create) => {
      await expect(
        NativeSQLiteRecordAdapter.open({ path: dbPath, create } as never),
      ).rejects.toThrow(/no ownerEntityId/);
      expect(existsSync(dbPath)).toBe(false);
    },
  );

  test('a lazy ownerEntityId is called when a store is created, sync or async', async () => {
    const sync = vi.fn(() => 'owner-sync');
    const a = await NativeSQLiteRecordAdapter.open({
      path: dbPath,
      create: 'exclusive',
      ownerEntityId: sync,
    });
    expect(a.ownerEntityId).toBe('owner-sync');
    expect(sync).toHaveBeenCalledOnce();
    await a.close();

    const b = await NativeSQLiteRecordAdapter.open({
      path: join(testDir, 'b.db'),
      create: 'ifMissing',
      ownerEntityId: async () => 'owner-async',
    });
    expect(b.ownerEntityId).toBe('owner-async');
  });

  test('a lazy ownerEntityId is not called when the store exists', async () => {
    await (await initAdapter()).close();
    const provider = vi.fn(() => 'unused');
    const adapter = await NativeSQLiteRecordAdapter.open({
      path: dbPath,
      create: 'ifMissing',
      ownerEntityId: provider,
    });
    expect(adapter.ownerEntityId).toBe('entity-123');
    expect(provider).not.toHaveBeenCalled();
  });

  test.each(['never', 'ifMissing'] as const)(
    "a mismatched plain-string owner throws OwnerMismatchError and releases the lock under '%s'",
    async (create) => {
      await (await initAdapter({ ownerEntityId: 'owner-abc' })).close();
      const err = await NativeSQLiteRecordAdapter.open({
        path: dbPath,
        create,
        ownerEntityId: 'owner-xyz',
      }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(OwnerMismatchError);
      expect((err as OwnerMismatchError).expected).toBe('owner-xyz');
      expect((err as OwnerMismatchError).actual).toBe('owner-abc');
      expect((err as OwnerMismatchError).where).toContain(dbPath);
      expect(existsSync(`${dbPath}.lock`)).toBe(false);
    },
  );

  // A store moves to a new layout only by being copied into one.
  // See docs/spec/adapters.md § Construction.
  test.each([
    ['another version', 'UPDATE format SET version = 2', 2],
    ['no version at all', 'DELETE FROM format', undefined],
    ['no format table', 'DROP TABLE format', undefined],
  ] as const)(
    'a store naming %s throws FormatMismatchError and releases the lock',
    async (_name, sql, actual) => {
      await (await initAdapter()).close();
      const db = new DatabaseSync(dbPath);
      db.exec(sql);
      db.close();
      const err = await NativeSQLiteRecordAdapter.open({ path: dbPath }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(FormatMismatchError);
      expect((err as FormatMismatchError).expected).toBe(1);
      expect((err as FormatMismatchError).actual).toBe(actual);
      expect(existsSync(`${dbPath}.lock`)).toBe(false);
    },
  );

  test('a store in another layout is refused before anything is written to it', async () => {
    await (await initAdapter()).close();
    const db = new DatabaseSync(dbPath);
    db.exec('UPDATE format SET version = 2; DROP TABLE content_index;');
    db.close();
    await expect(NativeSQLiteRecordAdapter.open({ path: dbPath })).rejects.toThrow(
      FormatMismatchError,
    );
    const after = new DatabaseSync(dbPath);
    const table = after
      .prepare(`SELECT name FROM sqlite_master WHERE name = 'content_index'`)
      .get();
    after.close();
    expect(table).toBeUndefined();
  });

  // A stack exists exactly when its file holds _config, so a file an
  // interrupted create left without one is a stack not yet created.
  // See docs/spec/adapters.md § Construction.
  describe('a file holding tables but no config record', () => {
    const halfMade = async () => {
      await (await initAdapter()).close();
      const db = new DatabaseSync(dbPath);
      db.exec(`DELETE FROM records WHERE id = '_config'; DELETE FROM format;`);
      db.close();
    };

    test.each(['ifMissing', 'exclusive'] as const)("is created under '%s'", async (create) => {
      await halfMade();
      const provider = vi.fn(() => 'owner-new');
      const adapter = await NativeSQLiteRecordAdapter.open({
        path: dbPath,
        create,
        ownerEntityId: provider,
      });
      expect(adapter.ownerEntityId).toBe('owner-new');
      expect(provider).toHaveBeenCalledOnce();
      await adapter.close();
      expect((await NativeSQLiteRecordAdapter.open({ path: dbPath })).ownerEntityId).toBe(
        'owner-new',
      );
    });

    test("is refused as missing under 'never', and releases the lock", async () => {
      await halfMade();
      await expect(NativeSQLiteRecordAdapter.open({ path: dbPath })).rejects.toThrow(
        /no database found/,
      );
      expect(existsSync(`${dbPath}.lock`)).toBe(false);
    });
  });

  test('a matching plain-string owner opens an existing store', async () => {
    await (await initAdapter({ ownerEntityId: 'owner-abc' })).close();
    const adapter = await NativeSQLiteRecordAdapter.open({
      path: dbPath,
      ownerEntityId: 'owner-abc',
    });
    expect(adapter.ownerEntityId).toBe('owner-abc');
  });
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
// Capabilities
// -------------------------------------------------------

describe('capabilities', () => {
  // Regression guard: this is a local, in-process adapter, so it has no
  // legitimate reason to decline content-field filtering — a future
  // refactor that regressed this to `false` would silently widen every
  // caller's query() results instead of erroring (see assertQueryCapabilities
  // in @haverstack/core).
  test("declares filter.content: 'path'", async () => {
    const adapter = await initAdapter();
    expect(adapter.capabilities.filter.content).toBe('path');
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
      createdBy: { subjectId: 'entity-xyz' },
      appId: 'app-123',
    });
    await adapter.createRecord(record);
    const retrieved = await adapter.getRecord(record.id);
    expect(retrieved?.parentId).toBe('parent-abc');
    expect(retrieved?.createdBy?.subjectId).toBe('entity-xyz');
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

  test('purging deleteRecord removes record entirely', async () => {
    const adapter = await initAdapter();
    const record = makeRecord();
    await adapter.createRecord(record);
    await adapter.deleteRecord(record.id, { purge: true });
    expect(await adapter.getRecord(record.id)).toBeNull();
  });

  test('purging deleteRecord removes version history', async () => {
    const adapter = await initAdapter();
    const record = makeRecord({ version: 2 });
    await adapter.importRecord(record, {
      versions: [
        {
          version: 1,
          typeId: record.typeId,
          content: record.content,
          updatedAt: record.updatedAt,
        },
      ],
      journal: [],
    });
    await adapter.deleteRecord(record.id, { purge: true });
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
// ifVersion (opt-in optimistic concurrency)
// -------------------------------------------------------

describe('ifVersion', () => {
  test('patchContent applies when ifVersion matches', async () => {
    const adapter = await initAdapter();
    const record = await adapter.createRecord(makeRecord());
    const updated = await adapter.patchContent(record.id, { text: 'Updated' }, { ifVersion: 1 });
    expect(updated.version).toBe(2);
    expect(updated.content).toEqual({ text: 'Updated' });
  });

  test('patchContent throws StackVersionConflictError and changes nothing when stale', async () => {
    const adapter = await initAdapter();
    const record = await adapter.createRecord(makeRecord());
    await adapter.patchContent(record.id, { text: 'first' }); // -> v2

    const err = await adapter
      .patchContent(record.id, { text: 'second' }, { ifVersion: 1 })
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
      .patchContent(record.id, { text: 'rejected update' }, { ifVersion: 999 })
      .catch(() => {});

    const stillFindsOriginal = await adapter.queryRecords(
      resolveQuery({ filter: { search: 'original' } }),
    );
    expect(stillFindsOriginal.records.map((r) => r.id)).toEqual([record.id]);
    const doesNotFindRejected = await adapter.queryRecords(
      resolveQuery({ filter: { search: 'rejected' } }),
    );
    expect(doesNotFindRejected.records).toEqual([]);
  });

  test('soft deleteRecord and undeleteRecord enforce ifVersion', async () => {
    const adapter = await initAdapter();
    const record = await adapter.createRecord(makeRecord());
    await adapter.patchContent(record.id, { text: 'v2' }); // -> v2

    await expect(adapter.deleteRecord(record.id, { ifVersion: 1 })).rejects.toBeInstanceOf(
      StackVersionConflictError,
    );
    await adapter.deleteRecord(record.id, { ifVersion: 2 }); // -> v3

    await expect(adapter.undeleteRecord(record.id, { ifVersion: 1 })).rejects.toBeInstanceOf(
      StackVersionConflictError,
    );
    const undeleted = await adapter.undeleteRecord(record.id, { ifVersion: 3 }); // -> v4
    expect(undeleted.version).toBe(4);
  });

  test('commitMigration enforces ifVersion and leaves typeId untouched on mismatch', async () => {
    const adapter = await initAdapter();
    const record = await adapter.createRecord(makeRecord({ content: { text: 'original' } }));
    await adapter.patchContent(record.id, { text: 'v2' }); // -> v2

    await expect(
      adapter.commitMigration(
        record.id,
        'com.example/note@2',
        { text: 'migrated' },
        {
          ifVersion: 1,
        },
      ),
    ).rejects.toBeInstanceOf(StackVersionConflictError);
    const untouched = await adapter.getRecord(record.id);
    expect(untouched?.typeId).toBe(record.typeId);
    expect(untouched?.version).toBe(2);
    // The rejected write must not have disturbed the FTS index either.
    const stillFindsV2 = await adapter.queryRecords(resolveQuery({ filter: { search: 'v2' } }));
    expect(stillFindsV2.records.map((r) => r.id)).toEqual([record.id]);

    const migrated = await adapter.commitMigration(
      record.id,
      'com.example/note@2',
      { text: 'migrated' },
      { ifVersion: 2 },
    ); // -> v3
    expect(migrated.typeId).toBe('com.example/note@2');
    expect(migrated.version).toBe(3);
  });

  test('purging deleteRecord enforces ifVersion and leaves the record untouched on mismatch', async () => {
    const adapter = await initAdapter();
    const record = await adapter.createRecord(makeRecord());
    await adapter.patchContent(record.id, { text: 'v2' }); // -> v2

    await expect(
      adapter.deleteRecord(record.id, { purge: true, ifVersion: 1 }),
    ).rejects.toBeInstanceOf(StackVersionConflictError);
    expect(await adapter.getRecord(record.id)).not.toBeNull();

    await adapter.deleteRecord(record.id, { purge: true, ifVersion: 2 });
    expect(await adapter.getRecord(record.id)).toBeNull();
  });

  test('associate and dissociate take no ifVersion and never bump', async () => {
    const adapter = await initAdapter();
    const record = await adapter.createRecord(makeRecord());

    await adapter.editAssociations(record.id, [
      { op: 'add', association: { kind: 'tag', label: 'x' } },
    ]);
    await adapter.editAssociations(record.id, [
      { op: 'remove', association: { kind: 'tag', label: 'x' } },
    ]);

    expect((await adapter.getRecord(record.id))?.version).toBe(1);
  });

  test('a write that does not bump racing a purge reports StackNotFoundError', async () => {
    const adapter = await initAdapter();
    const record = await adapter.createRecord(makeRecord());

    const [, mutated] = await Promise.allSettled([
      adapter.deleteRecord(record.id, { purge: true }),
      adapter.setAssociations(record.id, [{ kind: 'tag', label: 'x' }], { ifVersion: 1 }),
    ]);
    expect(mutated.status === 'rejected' && mutated.reason).toBeInstanceOf(StackNotFoundError);
  });

  test('concurrent unguarded patches both land', async () => {
    const adapter = await initAdapter();
    const record = await adapter.createRecord(makeRecord({ content: { a: 0, b: 0 } }));

    await Promise.all([
      adapter.patchContent(record.id, { a: 1 }),
      adapter.patchContent(record.id, { b: 1 }),
    ]);

    const after = await adapter.getRecord(record.id);
    expect(after?.content).toEqual({ a: 1, b: 1 });
    expect(after?.version).toBe(3);
  });

  test('setAccess enforces ifVersion and never bumps', async () => {
    const adapter = await initAdapter();
    const record = await adapter.createRecord(makeRecord());

    await expect(
      adapter.setAccess(record.id, [{ kind: 'anyone', label: 'read' }], { ifVersion: 99 }),
    ).rejects.toBeInstanceOf(StackVersionConflictError);

    await adapter.setAccess(record.id, [{ kind: 'anyone', label: 'read' }], { ifVersion: 1 });
    expect((await adapter.getRecord(record.id))?.version).toBe(1);
  });

  test('restoreVersion enforces ifVersion', async () => {
    const adapter = await initAdapter();
    const record = makeRecord({ version: 2, content: { text: 'v2' } });
    await adapter.importRecord(record, {
      versions: [
        {
          version: 1,
          typeId: record.typeId,
          content: { text: 'original' },
          updatedAt: record.updatedAt,
        },
      ],
      journal: [],
    });

    await expect(adapter.restoreVersion(record.id, 1, { ifVersion: 1 })).rejects.toBeInstanceOf(
      StackVersionConflictError,
    );

    const restored = await adapter.restoreVersion(record.id, 1, { ifVersion: 2 }); // -> v3
    expect(restored.version).toBe(3);
    expect(restored.content).toEqual({ text: 'original' });
  });

  test('associate on a nonexistent record throws StackNotFoundError', async () => {
    const adapter = await initAdapter();
    await expect(
      adapter.editAssociations('nonexistent', [
        { op: 'add', association: { kind: 'tag', label: 'x' } },
      ]),
    ).rejects.toThrow(StackNotFoundError);
  });
});

// -------------------------------------------------------
// ifVersion — checked inside the transaction that writes
// -------------------------------------------------------

/**
 * Two calls guarded on the same version: whichever commits first wins, and
 * the other sees the version it moved to.
 */
describe('ifVersion holds between concurrent writes', () => {
  test('restoreVersion: one of two racing restores wins', async () => {
    const adapter = await initAdapter();
    const record = makeRecord({ version: 2, content: { text: 'v2' } });
    await adapter.importRecord(record, {
      versions: [
        {
          version: 1,
          typeId: record.typeId,
          content: { text: 'original' },
          updatedAt: record.updatedAt,
        },
      ],
      journal: [],
    });

    const results = await Promise.allSettled([
      adapter.restoreVersion(record.id, 1, { ifVersion: 2 }),
      adapter.restoreVersion(record.id, 1, { ifVersion: 2 }),
    ]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected']);
    const err = (results[1] as PromiseRejectedResult).reason;
    expect(err).toBeInstanceOf(StackVersionConflictError);
    expect((err as StackVersionConflictError).actualVersion).toBe(3);
  });

  test('commitMigration: one of two racing migrations wins', async () => {
    const adapter = await initAdapter();
    const record = await adapter.createRecord(makeRecord({ content: { text: 'original' } }));

    const results = await Promise.allSettled([
      adapter.commitMigration(record.id, 'com.example/note@2', { text: 'a' }, { ifVersion: 1 }),
      adapter.commitMigration(record.id, 'com.example/note@2', { text: 'b' }, { ifVersion: 1 }),
    ]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected']);
    const err = (results[1] as PromiseRejectedResult).reason;
    expect(err).toBeInstanceOf(StackVersionConflictError);
    expect((err as StackVersionConflictError).actualVersion).toBe(2);

    const after = await adapter.getRecord(record.id);
    expect(after?.content).toEqual({ text: 'a' });
  });

  test('a soft delete stamps deleted_at and updated_at from one timestamp', async () => {
    const adapter = await initAdapter();
    const record = await adapter.createRecord(makeRecord());

    // Every no-arg `new Date()` reads a millisecond later than the last, so
    // two of them can never agree — which is exactly what a soft delete
    // taking its two columns from separate clock reads would do, and what
    // taking them from one cannot.
    const RealDate = Date;
    let tick = RealDate.now();
    vi.stubGlobal(
      'Date',
      class extends RealDate {
        constructor(...args: unknown[]) {
          // Only the no-arg form is the clock read under test; every other
          // form (fromMs() reading a row back, say) passes straight through.
          if (args.length === 0) super(tick++);
          else super(...(args as [number]));
        }
      },
    );

    try {
      const deleted = await adapter.deleteRecord(record.id);
      expect(deleted?.deletedAt?.getTime()).toBe(deleted?.updatedAt.getTime());
    } finally {
      vi.unstubAllGlobals();
    }
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
    const result = await adapter.queryRecords(resolveQuery({}));
    expect(result.records.length).toBe(2);
  });

  test('includeDeleted returns soft-deleted records', async () => {
    const adapter = await initAdapter();
    const record = makeRecord();
    await adapter.createRecord(record);
    await adapter.deleteRecord(record.id);
    const result = await adapter.queryRecords(resolveQuery({ filter: { includeDeleted: true } }));
    expect(result.records.some((r) => r.id === record.id)).toBe(true);
  });

  test('excludes unlisted records by default, and includeUnlisted returns them', async () => {
    const adapter = await initAdapter();
    const record = makeRecord();
    await adapter.createRecord(record);
    await adapter.setUnlisted(record.id, true);

    const excluded = await adapter.queryRecords(resolveQuery({}));
    expect(excluded.records.some((r) => r.id === record.id)).toBe(false);

    const included = await adapter.queryRecords(
      resolveQuery({ filter: { includeUnlisted: true } }),
    );
    expect(included.records.some((r) => r.id === record.id)).toBe(true);
  });

  // The order clause maps the direction from a fixed pair, so even a raw
  // string from a caller reaching the adapter directly runs as SQL text
  // the builder wrote.
  test('a sort direction outside asc/desc never reaches SQL text', async () => {
    const adapter = await initAdapter();
    await adapter.createRecord(makeRecord({ id: 'r1' }));
    const { records } = await adapter.queryRecords({
      limit: 50,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sort: { field: 'createdAt', direction: 'ASC, (SELECT 1)' as any },
    });
    expect(records.map((r) => r.id)).toEqual(['r1']);
  });

  test('filters by typeId', async () => {
    const adapter = await initAdapter();
    const noteType = makeRecord({ typeId: 'com.example/note@1' });
    const taskType = makeRecord({ typeId: 'com.example/task@1' });
    await adapter.createRecord(noteType);
    await adapter.createRecord(taskType);
    const result = await adapter.queryRecords(
      resolveQuery({ filter: { typeId: 'com.example/note@1' } }),
    );
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
    const result = await adapter.queryRecords(resolveQuery({ filter: { parentId: 'parent' } }));
    expect(result.records.length).toBe(1);
    expect(result.records[0].parentId).toBe('parent');
  });

  test('filters by content field', async () => {
    const adapter = await initAdapter();
    await adapter.createRecord(makeRecord({ id: 'r1', content: { text: 'alpha', priority: 1 } }));
    await adapter.createRecord(makeRecord({ id: 'r2', content: { text: 'beta', priority: 2 } }));
    const result = await adapter.queryRecords(
      resolveQuery({ filter: { content: { priority: 1 } } }),
    );
    expect(result.records.length).toBe(1);
    expect(result.records[0].id).toBe('r1');
  });

  // a null content filter means "field absent or null," never "match
  // nothing" — plain SQL `= NULL` is always false, so this needs IS NULL /
  // missing-path semantics to match at all.
  test('content filter with a null value matches records where the field is absent', async () => {
    const adapter = await initAdapter();
    await adapter.createRecord(makeRecord({ id: 'r1', content: { text: 'no priority set' } }));
    await adapter.createRecord(makeRecord({ id: 'r2', content: { text: 'has one', priority: 1 } }));
    const result = await adapter.queryRecords(
      resolveQuery({ filter: { content: { priority: null } } }),
    );
    expect(result.records.length).toBe(1);
    expect(result.records[0].id).toBe('r1');
  });

  test('content filter with a null value matches records where the field is stored as null', async () => {
    const adapter = await initAdapter();
    await adapter.createRecord(
      makeRecord({ id: 'r1', content: { text: 'explicit null', priority: null } }),
    );
    await adapter.createRecord(makeRecord({ id: 'r2', content: { text: 'has one', priority: 1 } }));
    const result = await adapter.queryRecords(
      resolveQuery({ filter: { content: { priority: null } } }),
    );
    expect(result.records.length).toBe(1);
    expect(result.records[0].id).toBe('r1');
  });

  // Presence is what an exact-match value cannot ask: a value matches what
  // is there, never whether anything is.
  test('contentPresent matches records holding a value at the path', async () => {
    const adapter = await initAdapter();
    await adapter.createRecord(makeRecord({ id: 'r1', content: { text: 'dated', at: '2021' } }));
    await adapter.createRecord(makeRecord({ id: 'r2', content: { text: 'undated' } }));
    await adapter.createRecord(makeRecord({ id: 'r3', content: { text: 'null', at: null } }));

    const present = await adapter.queryRecords(
      resolveQuery({ filter: { contentPresent: ['at'] } }),
    );
    expect(present.records.map((r) => r.id)).toEqual(['r1']);

    const absent = await adapter.queryRecords(resolveQuery({ filter: { content: { at: null } } }));
    expect(absent.records.map((r) => r.id).sort()).toEqual(['r2', 'r3']);
  });

  test('contentPresent reaches through an array, and empty holds nothing', async () => {
    const adapter = await initAdapter();
    await adapter.createRecord(
      makeRecord({ id: 'r1', content: { text: 'has one', emails: [{ value: 'a@b.c' }] } }),
    );
    await adapter.createRecord(
      makeRecord({ id: 'r2', content: { text: 'has none', emails: [{ label: 'home' }] } }),
    );
    await adapter.createRecord(makeRecord({ id: 'r3', content: { text: 'empty', emails: [] } }));

    const result = await adapter.queryRecords(
      resolveQuery({ filter: { contentPresent: ['emails.value'] } }),
    );
    expect(result.records.map((r) => r.id)).toEqual(['r1']);
  });

  test('contentPresent combines with a content filter and with a sort', async () => {
    const adapter = await initAdapter();
    await adapter.createRecord(
      makeRecord({ id: 'r1', content: { text: 'a', at: '2021', kind: 'post' } }),
    );
    await adapter.createRecord(
      makeRecord({ id: 'r2', content: { text: 'b', at: '2020', kind: 'post' } }),
    );
    await adapter.createRecord(makeRecord({ id: 'r3', content: { text: 'c', kind: 'post' } }));
    await adapter.createRecord(
      makeRecord({ id: 'r4', content: { text: 'd', at: '2022', kind: 'page' } }),
    );

    const result = await adapter.queryRecords(
      resolveQuery({
        filter: { contentPresent: ['at'], content: { kind: 'post' } },
        sort: { contentField: 'text', direction: 'asc' },
      }),
    );
    expect(result.records.map((r) => r.id)).toEqual(['r1', 'r2']);
  });

  test('content filter matches an element of a top-level array', async () => {
    const adapter = await initAdapter();
    await adapter.createRecord(
      makeRecord({ id: 'r1', content: { text: 'tagged', tags: ['starred', 'todo'] } }),
    );
    await adapter.createRecord(
      makeRecord({ id: 'r2', content: { text: 'plain', tags: ['todo'] } }),
    );
    const result = await adapter.queryRecords(
      resolveQuery({ filter: { content: { tags: 'starred' } } }),
    );
    expect(result.records.map((r) => r.id)).toEqual(['r1']);
  });

  test('nested path filter reaches an object property', async () => {
    const adapter = await initAdapter();
    await adapter.createRecord(
      makeRecord({ id: 'r1', content: { text: 'a', address: { city: 'Lisbon' } } }),
    );
    await adapter.createRecord(
      makeRecord({ id: 'r2', content: { text: 'b', address: { city: 'Porto' } } }),
    );
    const result = await adapter.queryRecords(
      resolveQuery({
        filter: { content: { 'address.city': 'Lisbon' } },
      }),
    );
    expect(result.records.map((r) => r.id)).toEqual(['r1']);
  });

  // The motivating shape: contact@1 stores emails as [{ value, label }],
  // so "which contact has this address" is one filter rather than a scan.
  test('nested path filter matches inside an array of objects', async () => {
    const adapter = await initAdapter();
    await adapter.createRecord(
      makeRecord({
        id: 'r1',
        content: {
          text: 'ada',
          emails: [
            { value: 'ada@example.com', label: 'home' },
            { value: 'a@work.example', label: 'work' },
          ],
        },
      }),
    );
    await adapter.createRecord(
      makeRecord({
        id: 'r2',
        content: { text: 'grace', emails: [{ value: 'grace@example.com', label: 'home' }] },
      }),
    );
    const byValue = await adapter.queryRecords(
      resolveQuery({
        filter: { content: { 'emails.value': 'a@work.example' } },
      }),
    );
    expect(byValue.records.map((r) => r.id)).toEqual(['r1']);

    const byLabel = await adapter.queryRecords(
      resolveQuery({ filter: { content: { 'emails.label': 'work' } } }),
    );
    expect(byLabel.records.map((r) => r.id)).toEqual(['r1']);
  });

  test('nested path filter walks more than one object level', async () => {
    const adapter = await initAdapter();
    await adapter.createRecord(
      makeRecord({ id: 'r1', content: { text: 'a', a: { b: { c: 7 } } } }),
    );
    await adapter.createRecord(
      makeRecord({ id: 'r2', content: { text: 'b', a: { b: { c: 8 } } } }),
    );
    const result = await adapter.queryRecords(
      resolveQuery({ filter: { content: { 'a.b.c': 7 } } }),
    );
    expect(result.records.map((r) => r.id)).toEqual(['r1']);
  });

  test('a dotted filter key is a path, never a literal field name', async () => {
    const adapter = await initAdapter();
    await adapter.createRecord(makeRecord({ id: 'r1', content: { text: 'nested', a: { b: 1 } } }));
    const result = await adapter.queryRecords(resolveQuery({ filter: { content: { 'a.b': 1 } } }));
    expect(result.records.map((r) => r.id)).toEqual(['r1']);
  });

  test('a nested path yielding no value matches a null filter', async () => {
    const adapter = await initAdapter();
    await adapter.createRecord(makeRecord({ id: 'r1', content: { text: 'no address at all' } }));
    await adapter.createRecord(makeRecord({ id: 'r2', content: { text: 'empty', address: {} } }));
    await adapter.createRecord(
      makeRecord({ id: 'r3', content: { text: 'stored null', address: { city: null } } }),
    );
    await adapter.createRecord(
      makeRecord({ id: 'r4', content: { text: 'present', address: { city: 'Lisbon' } } }),
    );
    const result = await adapter.queryRecords(
      resolveQuery({ filter: { content: { 'address.city': null } } }),
    );
    expect(result.records.map((r) => r.id).sort()).toEqual(['r1', 'r2', 'r3']);
  });

  test('a filter path descending through a scalar matches nothing', async () => {
    const adapter = await initAdapter();
    await adapter.createRecord(makeRecord({ id: 'r1', content: { text: 'a', a: 'hello' } }));
    const result = await adapter.queryRecords(
      resolveQuery({ filter: { content: { 'a.b': 'hello' } } }),
    );
    expect(result.records).toEqual([]);
  });

  test('a filter path segment carrying a reserved character is refused', async () => {
    const adapter = await initAdapter();
    await expect(
      adapter.queryRecords(resolveQuery({ filter: { content: { 'emails[0]': 'x' } } })),
    ).rejects.toThrow(StackBadRequestError);
    await expect(
      adapter.queryRecords(resolveQuery({ filter: { content: { 'a..b': 'x' } } })),
    ).rejects.toThrow(StackBadRequestError);
  });

  test('two content filters both apply', async () => {
    const adapter = await initAdapter();
    await adapter.createRecord(
      makeRecord({ id: 'r1', content: { text: 'a', a: { b: 1 }, c: 'yes' } }),
    );
    await adapter.createRecord(
      makeRecord({ id: 'r2', content: { text: 'b', a: { b: 1 }, c: 'no' } }),
    );
    const result = await adapter.queryRecords(
      resolveQuery({
        filter: { content: { 'a.b': 1, c: 'yes' } },
      }),
    );
    expect(result.records.map((r) => r.id)).toEqual(['r1']);
  });

  // A field name may hold anything but the reserved characters, and such a
  // name is matched as one segment rather than reinterpreted as syntax.
  test.each([
    ['spaced', 'sp ace'],
    ['backslashed', 'back\\slash'],
    ['colonned', 'a:b'],
  ])('a %s key is matched literally', async (_label, key) => {
    const adapter = await initAdapter();
    await adapter.createRecord(makeRecord({ id: 'r1', content: { text: 'a', [key]: 'hit' } }));
    await adapter.createRecord(makeRecord({ id: 'r2', content: { text: 'b', other: 'miss' } }));

    const result = await adapter.queryRecords(
      resolveQuery({ filter: { content: { [key]: 'hit' } } }),
    );
    expect(result.records.map((r) => r.id)).toEqual(['r1']);
  });

  // A key carrying path syntax is a structural fault in the request,
  // answered as StackBadRequestError (400) rather than reaching the engine as a
  // malformed path and escaping as a raw error.
  test('a key that is not path-shaped is refused, never an engine error', async () => {
    const adapter = await initAdapter();
    await adapter.createRecord(makeRecord({ id: 'r1', content: { text: 'present' } }));

    for (const key of ['$.', '[', '"', 'a[0', '', 'a..b', '*', '#']) {
      await expect(
        adapter.queryRecords(resolveQuery({ filter: { content: { [key]: 'x' } } })),
      ).rejects.toThrow(StackBadRequestError);
    }
  });

  // The longest legal path reaches the deepest value a write accepts, and
  // has to execute, not merely be accepted. See docs/spec/data-model.md
  // § Nested content paths.
  test('a path at the segment cap reaches the deepest value; one past it is refused', async () => {
    const adapter = await initAdapter();
    const segments = Array.from({ length: 33 }, (_, i) => `s${i}`);
    const deepest = segments.join('.');
    const nested = segments.reduceRight<unknown>((value, key) => ({ [key]: value }), 'x');
    await adapter.createRecord(makeRecord({ id: 'r1', content: { text: 'shallow' } }));
    await adapter.createRecord(
      makeRecord({ id: 'r2', content: { text: 'deep', ...(nested as object) } }),
    );

    await expect(
      adapter.queryRecords(resolveQuery({ filter: { content: { [deepest]: 'x' } } })),
    ).resolves.toMatchObject({ records: [{ id: 'r2' }] });
    await expect(
      adapter.queryRecords(resolveQuery({ filter: { content: { [deepest]: null } } })),
    ).resolves.toMatchObject({ records: [{ id: 'r1' }] });
    await expect(
      adapter.queryRecords(resolveQuery({ filter: { content: { [`${deepest}.s33`]: 'x' } } })),
    ).rejects.toThrow(StackBadRequestError);
  });

  // json_each exposes a stored object as its JSON text; a scalar filter
  // value must not match that text, or one filter would mean two things
  // depending on the backend.
  test('a scalar filter value never matches an object or array at the path', async () => {
    const adapter = await initAdapter();
    await adapter.createRecord(
      makeRecord({ id: 'r1', content: { text: 'a', a: { b: { k: 'v' } } } }),
    );
    await adapter.createRecord(makeRecord({ id: 'r2', content: { text: 'b', obj: { k: 'v' } } }));

    const nested = await adapter.queryRecords(
      resolveQuery({
        filter: { content: { 'a.b': '{"k":"v"}' } },
      }),
    );
    expect(nested.records).toEqual([]);
    const top = await adapter.queryRecords(
      resolveQuery({ filter: { content: { obj: '{"k":"v"}' } } }),
    );
    expect(top.records).toEqual([]);
  });

  test('full-text search (FTS5)', async () => {
    const adapter = await initAdapter();
    await adapter.createRecord(makeRecord({ id: 'r1', content: { text: 'SQLite is great' } }));
    await adapter.createRecord(
      makeRecord({ id: 'r2', content: { text: 'Postgres is also great' } }),
    );
    const result = await adapter.queryRecords(resolveQuery({ filter: { search: 'SQLite' } }));
    expect(result.records.length).toBe(1);
    expect(result.records[0].id).toBe('r1');
  });

  // a search term that sanitizes to nothing (here, a bare wildcard
  // FTS5 strips outright) must match nothing, not silently drop the search
  // clause and return the whole table as the "search result".
  test('a search term that sanitizes to empty matches nothing, not everything', async () => {
    const adapter = await initAdapter();
    await adapter.createRecord(makeRecord({ id: 'r1', content: { text: 'SQLite is great' } }));
    await adapter.createRecord(
      makeRecord({ id: 'r2', content: { text: 'Postgres is also great' } }),
    );
    const result = await adapter.queryRecords(resolveQuery({ filter: { search: '*' } }));
    expect(result.records).toEqual([]);
  });

  /**
   * The SqlExecutor the adapter's shared logic runs statements through —
   * the seam for standing in an engine failure that no input reliably
   * produces once the sanitizer has run.
   */
  const execOf = (adapter: NativeSQLiteRecordAdapter) =>
    (adapter as unknown as { record: { exec: { all: (...args: unknown[]) => unknown } } }).record
      .exec;

  // Search text is what a person typed into a box. These shapes are
  // ordinary input that FTS5 rejects outright, and the sanitizer repairs
  // them into a query the engine will run.
  test.each([
    ['an unbalanced quote', '5" nails'],
    ['a trailing operator', 'SQLite AND'],
    ['a leading operator', 'AND SQLite'],
    ['stacked operators', 'SQLite AND OR Postgres'],
    ['an operator dangling in parens', '(SQLite AND)'],
  ])('search survives %s', async (_label, search) => {
    const adapter = await initAdapter();
    await adapter.createRecord(makeRecord({ id: 'r1', content: { text: 'SQLite is great' } }));
    await expect(adapter.queryRecords(resolveQuery({ filter: { search } }))).resolves.toBeDefined();
  });

  test('a repaired search still finds its terms', async () => {
    const adapter = await initAdapter();
    await adapter.createRecord(makeRecord({ id: 'r1', content: { text: 'SQLite is great' } }));
    await adapter.createRecord(
      makeRecord({ id: 'r2', content: { text: 'Postgres is also great' } }),
    );
    const result = await adapter.queryRecords(resolveQuery({ filter: { search: 'SQLite AND' } }));
    expect(result.records.map((r) => r.id)).toEqual(['r1']);
  });

  // The backstop behind the sanitizer, which claims no completeness
  // against FTS5's grammar: whatever reaches the engine and fails to parse
  // is a bad_request, never a raw engine error a server has no code to map.
  test('search text the engine cannot parse raises StackBadRequestError', async () => {
    const adapter = await initAdapter();
    await adapter.createRecord(makeRecord({ id: 'r1', content: { text: 'SQLite is great' } }));
    // Reach past the sanitizer to stand in for a grammar case it misses.
    vi.spyOn(execOf(adapter), 'all').mockImplementation(() => {
      throw new Error('fts5: syntax error near ""');
    });
    await expect(
      adapter.queryRecords(resolveQuery({ filter: { search: 'anything' } })),
    ).rejects.toThrow(StackBadRequestError);
  });

  test('a non-search query failure is not relabelled as a bad request', async () => {
    const adapter = await initAdapter();
    vi.spyOn(execOf(adapter), 'all').mockImplementation(() => {
      throw new Error('database disk image is malformed');
    });
    await expect(
      adapter.queryRecords(resolveQuery({ filter: { typeId: 'x/y@1' } })),
    ).rejects.toThrow('database disk image is malformed');
  });

  test('full-text search reflects patchContent updates (not stale index entries)', async () => {
    const adapter = await initAdapter();
    const record = makeRecord({ content: { text: 'original content here' } });
    await adapter.createRecord(record);
    await adapter.patchContent(record.id, { text: 'updated content here' });

    const staleSearch = await adapter.queryRecords(
      resolveQuery({ filter: { search: 'original' } }),
    );
    expect(staleSearch.records).toEqual([]);
    const freshSearch = await adapter.queryRecords(resolveQuery({ filter: { search: 'updated' } }));
    expect(freshSearch.records.map((r) => r.id)).toEqual([record.id]);
  });

  test('full-text search no longer finds purged records', async () => {
    const adapter = await initAdapter();
    const record = makeRecord({ content: { text: 'findme unique token' } });
    await adapter.createRecord(record);
    await adapter.deleteRecord(record.id, { purge: true });

    const result = await adapter.queryRecords(resolveQuery({ filter: { search: 'findme' } }));
    expect(result.records).toEqual([]);
  });

  test('cursor pagination returns correct pages', async () => {
    const adapter = await initAdapter();
    for (let i = 0; i < 5; i++) {
      await adapter.createRecord(
        makeRecord({ id: `r${i}`, createdAt: new Date(Date.now() + i * 1000) }),
      );
    }
    const page1 = await adapter.queryRecords(
      resolveQuery({
        sort: { field: 'createdAt', direction: 'asc' },
        limit: 3,
      }),
    );
    expect(page1.records.length).toBe(3);
    expect(page1.cursor).not.toBeNull();

    const page2 = await adapter.queryRecords(
      resolveQuery({
        sort: { field: 'createdAt', direction: 'asc' },
        limit: 3,
        cursor: page1.cursor!,
      }),
    );
    expect(page2.records.length).toBe(2);
    expect(page2.cursor).toBeNull();
  });

  test('malformed cursor throws StackBadRequestError', async () => {
    const adapter = await initAdapter();
    await adapter.createRecord(makeRecord({ id: 'r1' }));
    await expect(
      adapter.queryRecords(resolveQuery({ cursor: '!!!not-a-cursor!!!' })),
    ).rejects.toThrow(StackBadRequestError);
  });

  test('cursor minted under one sort field replayed with a different sort field throws StackBadRequestError', async () => {
    const adapter = await initAdapter();
    for (let i = 0; i < 5; i++) {
      await adapter.createRecord(makeRecord({ id: `r${i}`, createdAt: new Date(i * 1000) }));
    }
    const page1 = await adapter.queryRecords(
      resolveQuery({
        sort: { field: 'createdAt', direction: 'asc' },
        limit: 3,
      }),
    );
    expect(page1.cursor).not.toBeNull();

    await expect(
      adapter.queryRecords(
        resolveQuery({
          sort: { field: 'version', direction: 'asc' },
          limit: 3,
          cursor: page1.cursor!,
        }),
      ),
    ).rejects.toThrow(StackBadRequestError);
  });

  test('sort by createdAt descending (default)', async () => {
    const adapter = await initAdapter();
    await adapter.createRecord(makeRecord({ id: 'r1', createdAt: new Date(1000) }));
    await adapter.createRecord(makeRecord({ id: 'r2', createdAt: new Date(2000) }));
    await adapter.createRecord(makeRecord({ id: 'r3', createdAt: new Date(3000) }));
    const result = await adapter.queryRecords(
      resolveQuery({ sort: { field: 'createdAt', direction: 'desc' } }),
    );
    expect(result.records.map((r) => r.id)).toEqual(['r3', 'r2', 'r1']);
  });
});

// -------------------------------------------------------
// file-ref indexing
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

  test('referencesFileId filter matches a record via a top-level file-ref field', async () => {
    const adapter = await initAdapter();
    await adapter.saveType(FILE_REF_TYPE);
    await adapter.createRecord(
      makeRecord({ id: 'r1', typeId: FILE_REF_TYPE.id, content: { coverFileId: 'file-1' } }),
    );

    const result = await adapter.queryRecords(
      resolveQuery({ filter: { referencesFileId: 'file-1' } }),
    );
    expect(result.records.map((r) => r.id)).toEqual(['r1']);
  });

  test('referencesFileId filter does not match a plain string field holding the same value', async () => {
    const adapter = await initAdapter();
    await adapter.saveType(STRING_TYPE);
    await adapter.createRecord(
      makeRecord({ id: 'r1', typeId: STRING_TYPE.id, content: { coverFileId: 'file-1' } }),
    );

    const result = await adapter.queryRecords(
      resolveQuery({ filter: { referencesFileId: 'file-1' } }),
    );
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

    const oldMatch = await adapter.queryRecords(
      resolveQuery({ filter: { referencesFileId: 'file-1' } }),
    );
    expect(oldMatch.records).toEqual([]);
    const newMatch = await adapter.queryRecords(
      resolveQuery({ filter: { referencesFileId: 'file-2' } }),
    );
    expect(newMatch.records.map((r) => r.id)).toEqual(['r1']);
  });

  test('purge removes the record from file-ref matching', async () => {
    const adapter = await initAdapter();
    await adapter.saveType(FILE_REF_TYPE);
    await adapter.createRecord(
      makeRecord({ id: 'r1', typeId: FILE_REF_TYPE.id, content: { coverFileId: 'file-1' } }),
    );
    await adapter.deleteRecord('r1', { purge: true });

    const result = await adapter.queryRecords(
      resolveQuery({ filter: { referencesFileId: 'file-1' } }),
    );
    expect(result.records).toEqual([]);
  });

  test('deleteUnreferencedAttachmentRecords is blocked by a content-held file-ref field', async () => {
    const adapter = await initAdapter();
    const ATTACHMENT_FAMILY = 'com.example.test/_attachment';
    const ATTACHMENT_TYPE = `${ATTACHMENT_FAMILY}@1`;
    await adapter.saveType(FILE_REF_TYPE);
    await adapter.createRecord(
      makeRecord({ id: 'meta1', typeId: ATTACHMENT_TYPE, content: { fileId: 'file-1' } }),
    );
    await adapter.createRecord(
      makeRecord({ id: 'r1', typeId: FILE_REF_TYPE.id, content: { coverFileId: 'file-1' } }),
    );

    await expect(
      adapter.deleteUnreferencedAttachmentRecords('file-1', ATTACHMENT_FAMILY),
    ).rejects.toThrow(StackConflictError);
    expect(await adapter.getRecord('meta1')).not.toBeNull();
  });

  // The fields content_index covers are cached per typeId (keyed off
  // saveType()) so that ContentIndex.sync() doesn't re-query and re-parse the
  // schema on every write — this pins that redefining a type reaches the
  // cache.
  test('redefining a type via saveType updates which fields are treated as file-ref', async () => {
    const adapter = await initAdapter();
    await adapter.saveType(FILE_REF_TYPE);
    await adapter.createRecord(
      makeRecord({ id: 'r1', typeId: FILE_REF_TYPE.id, content: { coverFileId: 'file-1' } }),
    );
    let result = await adapter.queryRecords(
      resolveQuery({ filter: { referencesFileId: 'file-1' } }),
    );
    expect(result.records.map((r) => r.id)).toEqual(['r1']);

    // Redefine the same typeId so coverFileId is no longer a file-ref field.
    await adapter.saveType({ ...FILE_REF_TYPE, schema: STRING_TYPE.schema });
    await adapter.patchContent('r1', { coverFileId: 'file-1' });

    result = await adapter.queryRecords(resolveQuery({ filter: { referencesFileId: 'file-1' } }));
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

    const result = await reopened.queryRecords(
      resolveQuery({ filter: { referencesFileId: 'file-1' } }),
    );
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
    await adapter.editAssociations(record.id, [
      { op: 'add', association: { kind: 'tag', label: 'starred' } },
    ]);
    const retrieved = await adapter.getRecord(record.id);
    expect(retrieved?.associations?.some((a) => a.kind === 'tag' && a.label === 'starred')).toBe(
      true,
    );
  });

  test('dissociate removes a tag', async () => {
    const adapter = await initAdapter();
    const record = makeRecord();
    await adapter.createRecord(record);
    await adapter.editAssociations(record.id, [
      { op: 'add', association: { kind: 'tag', label: 'starred' } },
    ]);
    await adapter.editAssociations(record.id, [
      { op: 'remove', association: { kind: 'tag', label: 'starred' } },
    ]);
    const retrieved = await adapter.getRecord(record.id);
    const hasStarred = (retrieved?.associations ?? []).some((a) => a.label === 'starred');
    expect(hasStarred).toBe(false);
    // dissociating the only association omits the key entirely
    // (undefined), never a bare `[]` — this is the shape MemoryAdapter must
    // match too, since it's what a fresh record's snapshot also uses.
    expect(retrieved?.associations).toBeUndefined();
  });

  test('associate is idempotent — duplicate does not create two entries', async () => {
    const adapter = await initAdapter();
    const record = makeRecord();
    await adapter.createRecord(record);
    await adapter.editAssociations(record.id, [
      { op: 'add', association: { kind: 'tag', label: 'starred' } },
    ]);
    await adapter.editAssociations(record.id, [
      { op: 'add', association: { kind: 'tag', label: 'starred' } },
    ]);
    const retrieved = await adapter.getRecord(record.id);
    const stars = retrieved?.associations?.filter((a) => a.kind === 'tag' && a.label === 'starred');
    expect(stars?.length).toBe(1);
  });

  test('associate never bumps version', async () => {
    const adapter = await initAdapter();
    const record = makeRecord();
    await adapter.createRecord(record);
    await adapter.editAssociations(record.id, [
      { op: 'add', association: { kind: 'tag', label: 'starred' } },
    ]);
    const retrieved = await adapter.getRecord(record.id);
    expect(retrieved?.version).toBe(1);
  });

  test('associate on a nonexistent record throws StackNotFoundError instead of creating an orphan row', async () => {
    const adapter = await initAdapter();
    await expect(
      adapter.editAssociations('does-not-exist', [
        { op: 'add', association: { kind: 'tag', label: 'starred' } },
      ]),
    ).rejects.toThrow(StackNotFoundError);
  });

  test('an attachment association round-trips its attachmentRecordId', async () => {
    const adapter = await initAdapter();
    const record = makeRecord();
    await adapter.createRecord(record);
    const association = {
      kind: 'attachment' as const,
      label: 'embed',
      fileId: 'a'.repeat(64),
      attachmentRecordId: '1hk153x00001',
    };

    await adapter.editAssociations(record.id, [{ op: 'add', association: association }]);

    expect((await adapter.getRecord(record.id))?.associations).toEqual([association]);
  });

  test('an attachment association with no pointer omits the key', async () => {
    const adapter = await initAdapter();
    const record = makeRecord();
    await adapter.createRecord(record);
    const association = { kind: 'attachment' as const, label: 'embed', fileId: 'a'.repeat(64) };

    await adapter.editAssociations(record.id, [{ op: 'add', association: association }]);

    expect((await adapter.getRecord(record.id))?.associations).toEqual([association]);
  });

  // attachment_record_id sits outside the primary key, so a re-pointed
  // association lands on the row already there.
  test('re-pointing an attachment association updates the one row', async () => {
    const adapter = await initAdapter();
    const record = makeRecord();
    await adapter.createRecord(record);
    const fileId = 'a'.repeat(64);
    await adapter.editAssociations(record.id, [
      {
        op: 'add',
        association: {
          kind: 'attachment',
          label: 'embed',
          fileId,
          attachmentRecordId: '1hk153x00001',
        },
      },
    ]);

    await adapter.editAssociations(record.id, [
      {
        op: 'add',
        association: {
          kind: 'attachment',
          label: 'embed',
          fileId,
          attachmentRecordId: '1hk153x00002',
        },
      },
    ]);

    expect((await adapter.getRecord(record.id))?.associations).toEqual([
      { kind: 'attachment', label: 'embed', fileId, attachmentRecordId: '1hk153x00002' },
    ]);
  });

  test('re-associating without a pointer clears the column', async () => {
    const adapter = await initAdapter();
    const record = makeRecord();
    await adapter.createRecord(record);
    const fileId = 'a'.repeat(64);
    await adapter.editAssociations(record.id, [
      {
        op: 'add',
        association: {
          kind: 'attachment',
          label: 'embed',
          fileId,
          attachmentRecordId: '1hk153x00001',
        },
      },
    ]);

    await adapter.editAssociations(record.id, [
      { op: 'add', association: { kind: 'attachment', label: 'embed', fileId } },
    ]);

    expect((await adapter.getRecord(record.id))?.associations).toEqual([
      { kind: 'attachment', label: 'embed', fileId },
    ]);
  });

  test('every target arm round-trips through storage', async () => {
    const adapter = await initAdapter();
    const record = makeRecord();
    await adapter.createRecord(record);
    const targets = [
      { kind: 'record' as const, recordId: 'rec-other' },
      { kind: 'record' as const, recordId: 'rec-other', stackUrl: 'https://alice.example/stack' },
      { kind: 'entity' as const, entityId: 'did:key:z6MkAlice' },
      { kind: 'external' as const, ns: 'atproto', id: 'at://did:plc:abc/app.bsky.feed.post/3k4' },
    ];
    for (const target of targets) {
      await adapter.editAssociations(record.id, [
        { op: 'add', association: { kind: 'relationship', label: 'ref', target } },
      ]);
    }

    const retrieved = await adapter.getRecord(record.id);
    const stored = (retrieved?.associations ?? []).flatMap((a) =>
      a.kind === 'relationship' ? [a.target] : [],
    );
    expect(stored).toEqual(expect.arrayContaining(targets));
    expect(stored).toHaveLength(targets.length);
  });

  // The primary key includes the namespace, so two copies of one utterance
  // on two networks are two associations rather than a silent no-op.
  test('targets differing only by namespace are distinct associations', async () => {
    const adapter = await initAdapter();
    const record = makeRecord();
    await adapter.createRecord(record);
    await adapter.editAssociations(record.id, [
      {
        op: 'add',
        association: {
          kind: 'relationship',
          label: 'syndicated-to',
          target: { kind: 'external', ns: 'atproto', id: 'copy-1' },
        },
      },
    ]);
    await adapter.editAssociations(record.id, [
      {
        op: 'add',
        association: {
          kind: 'relationship',
          label: 'syndicated-to',
          target: { kind: 'external', ns: 'activitypub', id: 'copy-1' },
        },
      },
    ]);

    const retrieved = await adapter.getRecord(record.id);
    expect(retrieved?.associations).toHaveLength(2);
  });

  test('dissociate removes only the target it names', async () => {
    const adapter = await initAdapter();
    const record = makeRecord();
    await adapter.createRecord(record);
    await adapter.editAssociations(record.id, [
      {
        op: 'add',
        association: {
          kind: 'relationship',
          label: 'syndicated-to',
          target: { kind: 'external', ns: 'atproto', id: 'copy-1' },
        },
      },
    ]);
    await adapter.editAssociations(record.id, [
      {
        op: 'add',
        association: {
          kind: 'relationship',
          label: 'syndicated-to',
          target: { kind: 'external', ns: 'activitypub', id: 'copy-1' },
        },
      },
    ]);
    await adapter.editAssociations(record.id, [
      {
        op: 'remove',
        association: {
          kind: 'relationship',
          label: 'syndicated-to',
          target: { kind: 'external', ns: 'atproto', id: 'copy-1' },
        },
      },
    ]);

    const retrieved = await adapter.getRecord(record.id);
    expect(retrieved?.associations).toEqual([
      {
        kind: 'relationship',
        label: 'syndicated-to',
        target: { kind: 'external', ns: 'activitypub', id: 'copy-1' },
      },
    ]);
  });
});

// -------------------------------------------------------
// relatedTo filter
// -------------------------------------------------------

describe('records — relatedTo filter', () => {
  const seed = async (adapter: Awaited<ReturnType<typeof initAdapter>>) => {
    const series = makeRecord({ id: 'rec-series', content: { text: 'in a series' } });
    const syndicated = makeRecord({ id: 'rec-syndicated', content: { text: 'crossposted' } });
    const authored = makeRecord({ id: 'rec-authored', content: { text: 'by someone' } });
    const bare = makeRecord({ id: 'rec-bare', content: { text: 'unrelated' } });
    for (const r of [series, syndicated, authored, bare]) await adapter.createRecord(r);
    await adapter.editAssociations(series.id, [
      {
        op: 'add',
        association: {
          kind: 'relationship',
          label: 'series',
          target: { kind: 'record', recordId: 'rec-subject' },
        },
      },
    ]);
    await adapter.editAssociations(syndicated.id, [
      {
        op: 'add',
        association: {
          kind: 'relationship',
          label: 'syndicated-to',
          target: {
            kind: 'external',
            ns: 'atproto',
            id: 'at://did:plc:abc/app.bsky.feed.post/3k4',
          },
        },
      },
    ]);
    await adapter.editAssociations(authored.id, [
      {
        op: 'add',
        association: {
          kind: 'relationship',
          label: 'author',
          target: { kind: 'entity', entityId: 'did:key:z6MkAlice' },
        },
      },
    ]);
  };

  const ids = (result: { records: StackRecord[] }) => result.records.map((r) => r.id).sort();

  test('matches a record target', async () => {
    const adapter = await initAdapter();
    await seed(adapter);
    const result = await adapter.queryRecords(
      resolveQuery({
        filter: { relatedTo: { target: { kind: 'record', recordId: 'rec-subject' } } },
      }),
    );
    expect(ids(result)).toEqual(['rec-series']);
  });

  test('matches an entity target', async () => {
    const adapter = await initAdapter();
    await seed(adapter);
    const result = await adapter.queryRecords(
      resolveQuery({
        filter: { relatedTo: { target: { kind: 'entity', entityId: 'did:key:z6MkAlice' } } },
      }),
    );
    expect(ids(result)).toEqual(['rec-authored']);
  });

  test('an external target without an id matches the whole namespace', async () => {
    const adapter = await initAdapter();
    await seed(adapter);
    const result = await adapter.queryRecords(
      resolveQuery({
        filter: { relatedTo: { target: { kind: 'external', ns: 'atproto' } } },
      }),
    );
    expect(ids(result)).toEqual(['rec-syndicated']);
  });

  test('a bare label matches every target under it', async () => {
    const adapter = await initAdapter();
    await seed(adapter);
    const result = await adapter.queryRecords(
      resolveQuery({ filter: { relatedTo: { label: 'author' } } }),
    );
    expect(ids(result)).toEqual(['rec-authored']);
  });

  // An entity target and a record target holding the same string are
  // different references — the distinction group rosters rest on.
  test('a record target does not match an entity target with the same value', async () => {
    const adapter = await initAdapter();
    await seed(adapter);
    const result = await adapter.queryRecords(
      resolveQuery({
        filter: { relatedTo: { target: { kind: 'record', recordId: 'did:key:z6MkAlice' } } },
      }),
    );
    expect(result.records).toHaveLength(0);
  });

  // An absent stackUrl names this stack rather than acting as a wildcard.
  test('a local record target does not match the same id in another stack', async () => {
    const adapter = await initAdapter();
    await seed(adapter);
    const remote = makeRecord({ id: 'rec-remote' });
    await adapter.createRecord(remote);
    await adapter.editAssociations(remote.id, [
      {
        op: 'add',
        association: {
          kind: 'relationship',
          label: 'reply-to',
          target: {
            kind: 'record',
            recordId: 'rec-elsewhere',
            stackUrl: 'https://alice.example/stack',
          },
        },
      },
    ]);

    const local = await adapter.queryRecords(
      resolveQuery({
        filter: { relatedTo: { target: { kind: 'record', recordId: 'rec-elsewhere' } } },
      }),
    );
    expect(local.records).toHaveLength(0);

    const scoped = await adapter.queryRecords(
      resolveQuery({
        filter: {
          relatedTo: {
            target: {
              kind: 'record',
              recordId: 'rec-elsewhere',
              stackUrl: 'https://alice.example/stack',
            },
          },
        },
      }),
    );
    expect(ids(scoped)).toEqual(['rec-remote']);
  });
});

describe('records — attachment filter', () => {
  const seed = async (adapter: Awaited<ReturnType<typeof initAdapter>>) => {
    const both = makeRecord({ id: 'rec-both' });
    const cover = makeRecord({ id: 'rec-cover' });
    for (const r of [both, cover]) await adapter.createRecord(r);
    await adapter.editAssociations(both.id, [
      { op: 'add', association: { kind: 'attachment', label: 'cover', fileId: 'file-1' } },
    ]);
    await adapter.editAssociations(both.id, [
      { op: 'add', association: { kind: 'attachment', label: 'thumb', fileId: 'file-2' } },
    ]);
    await adapter.editAssociations(cover.id, [
      { op: 'add', association: { kind: 'attachment', label: 'cover', fileId: 'file-2' } },
    ]);
  };

  const ids = (result: { records: StackRecord[] }) => result.records.map((r) => r.id).sort();

  test('a label and a fileId together match one association', async () => {
    const adapter = await initAdapter();
    await seed(adapter);
    const result = await adapter.queryRecords(
      resolveQuery({
        filter: { attachment: { label: 'cover', fileId: 'file-2' } },
      }),
    );
    expect(ids(result)).toEqual(['rec-cover']);
  });

  test('a label alone matches every file under it', async () => {
    const adapter = await initAdapter();
    await seed(adapter);
    const result = await adapter.queryRecords(
      resolveQuery({ filter: { attachment: { label: 'cover' } } }),
    );
    expect(ids(result)).toEqual(['rec-both', 'rec-cover']);
  });

  test('a fileId alone matches every label holding it', async () => {
    const adapter = await initAdapter();
    await seed(adapter);
    const result = await adapter.queryRecords(
      resolveQuery({ filter: { attachment: { fileId: 'file-2' } } }),
    );
    expect(ids(result)).toEqual(['rec-both', 'rec-cover']);
  });
});

// -------------------------------------------------------
// Permissions
// -------------------------------------------------------

describe('setAccess and editAccess', () => {
  test('replaces permissions', async () => {
    const adapter = await initAdapter();
    const record = makeRecord();
    await adapter.createRecord(record);
    await adapter.setAccess(record.id, [{ kind: 'anyone', label: 'read' }]);
    const retrieved = await adapter.getRecord(record.id);
    expect(retrieved?.permissions).toEqual([{ kind: 'anyone', label: 'read' }]);
  });

  // Two tables, so a tag write cannot reach an ACL.
  test('each set verb replaces only its own table', async () => {
    const adapter = await initAdapter();
    const record = makeRecord({
      associations: [{ kind: 'tag', label: 'draft' }],
      permissions: [{ kind: 'anyone', label: 'read' }],
    });
    await adapter.createRecord(record);

    await adapter.setAssociations(record.id, [{ kind: 'tag', label: 'reviewed' }]);
    const afterTags = await adapter.getRecord(record.id);
    expect(afterTags?.associations).toEqual([{ kind: 'tag', label: 'reviewed' }]);
    expect(afterTags?.permissions).toEqual([{ kind: 'anyone', label: 'read' }]);

    await adapter.setAccess(record.id, []);
    const afterAcl = await adapter.getRecord(record.id);
    expect(afterAcl?.associations).toEqual([{ kind: 'tag', label: 'reviewed' }]);
    expect(afterAcl?.permissions).toBeUndefined();
  });

  // `role` is in the primary key, so member and admin are two rows rather
  // than one row overwritten.
  test('a group grantee round trips per role', async () => {
    const adapter = await initAdapter();
    const record = makeRecord();
    await adapter.createRecord(record);
    const permissions: AuthorityAssociation[] = [
      {
        kind: 'permission',
        label: 'read',
        grantee: { kind: 'group', groupId: 'group-1', role: 'member' },
      },
      {
        kind: 'permission',
        label: 'read',
        grantee: { kind: 'group', groupId: 'group-1', role: 'admin' },
      },
    ];
    await adapter.setAccess(record.id, permissions);
    // Row order is the table's, not the write's: both are stored, which is
    // what the key column buys.
    expect((await adapter.getRecord(record.id))?.permissions).toEqual(
      expect.arrayContaining(permissions),
    );
    expect((await adapter.getRecord(record.id))?.permissions).toHaveLength(2);
  });

  // A grantee and a relationship target naming one entity are stored in
  // different tables, so neither can be read back as the other.
  test('a permission and a relationship to the same entity stay apart', async () => {
    const adapter = await initAdapter();
    const record = makeRecord();
    await adapter.createRecord(record);
    const entityId = 'did:key:z6MkMember';
    const grant: AuthorityAssociation = {
      kind: 'permission',
      label: 'read',
      grantee: { kind: 'entity', entityId },
    };
    await adapter.editAccess(record.id, [{ op: 'add', association: grant }]);

    const related = await adapter.queryRecords(
      resolveQuery({
        filter: { relatedTo: { target: { kind: 'entity', entityId } } },
      }),
    );
    expect(related.records.map((r) => r.id)).not.toContain(record.id);

    const revoked = await adapter.editAccess(record.id, [{ op: 'remove', association: grant }]);
    expect(revoked.permissions).toBeUndefined();
  });
});

describe('setUnlisted', () => {
  test('sets unlistedAt without bumping version', async () => {
    const adapter = await initAdapter();
    const record = makeRecord();
    await adapter.createRecord(record);
    await adapter.setUnlisted(record.id, true);
    const retrieved = await adapter.getRecord(record.id);
    expect(retrieved?.unlistedAt).toBeInstanceOf(Date);
    expect(retrieved?.version).toBe(1);
  });

  test('clears unlistedAt on the reverse call', async () => {
    const adapter = await initAdapter();
    const record = makeRecord();
    await adapter.createRecord(record);
    await adapter.setUnlisted(record.id, true);
    await adapter.setUnlisted(record.id, false);
    const retrieved = await adapter.getRecord(record.id);
    expect(retrieved?.unlistedAt).toBeUndefined();
    expect(retrieved?.version).toBe(1);
  });

  test('enforces ifVersion', async () => {
    const adapter = await initAdapter();
    const record = makeRecord();
    await adapter.createRecord(record);
    await expect(adapter.setUnlisted(record.id, true, { ifVersion: 99 })).rejects.toBeInstanceOf(
      StackVersionConflictError,
    );
    await adapter.setUnlisted(record.id, true, { ifVersion: 1 });
  });
});

// SQL NULL is the only spelling of an absent field. The empty string and
// the epoch are values, and the query predicates beside the mapper read
// `IS NULL` — so a mapper reading truthiness would answer one way to
// getRecord() and another to the filter that should have found it.
describe('absent fields are read by presence, not truthiness', () => {
  test('an empty-string parentId survives the round trip instead of reading as the root', async () => {
    const adapter = await initAdapter();
    const record = makeRecord({ parentId: '' });
    await adapter.createRecord(record);
    expect((await adapter.getRecord(record.id))?.parentId).toBe('');
    // And it is not at the root, which is what the filter already said.
    const roots = await adapter.queryRecords(resolveQuery({ filter: { parentId: null } }));
    expect(roots.records.map((r) => r.id)).not.toContain(record.id);
  });

  test('a parentId of an empty string stores it rather than clearing the parent', async () => {
    const adapter = await initAdapter();
    const box = makeRecord();
    await adapter.createRecord(box);
    const record = makeRecord({ parentId: box.id });
    await adapter.createRecord(record);
    await adapter.setParent(record.id, '');
    expect((await adapter.getRecord(record.id))?.parentId).toBe('');
  });

  test('a deletedAt at the epoch reads back as a tombstone', async () => {
    const adapter = await initAdapter();
    const record = makeRecord({ deletedAt: new Date(0) });
    await adapter.createRecord(record);
    expect((await adapter.getRecord(record.id))?.deletedAt).toEqual(new Date(0));
    // The query predicate already excluded it; now getRecord() agrees.
    const live = await adapter.queryRecords(resolveQuery({}));
    expect(live.records.map((r) => r.id)).not.toContain(record.id);
  });

  test('an unlistedAt at the epoch reads back as unlisted', async () => {
    const adapter = await initAdapter();
    const record = makeRecord({ unlistedAt: new Date(0) });
    await adapter.createRecord(record);
    expect((await adapter.getRecord(record.id))?.unlistedAt).toEqual(new Date(0));
  });

  test('empty-string authorship fields survive the round trip', async () => {
    const adapter = await initAdapter();
    const record = makeRecord({
      createdBy: { subjectId: '' },
      appId: '',
      updatedBy: { subjectId: '' },
    });
    await adapter.createRecord(record);
    const retrieved = await adapter.getRecord(record.id);
    expect(retrieved?.createdBy?.subjectId).toBe('');
    expect(retrieved?.appId).toBe('');
    expect(retrieved?.updatedBy?.subjectId).toBe('');
  });
});

describe('setParent', () => {
  test('sets parent_id without bumping version', async () => {
    const adapter = await initAdapter();
    const box = makeRecord();
    const record = makeRecord();
    await adapter.createRecord(box);
    await adapter.createRecord(record);
    await adapter.setParent(record.id, box.id);
    const retrieved = await adapter.getRecord(record.id);
    expect(retrieved?.parentId).toBe(box.id);
    expect(retrieved?.version).toBe(1);
  });

  test('null clears parent_id', async () => {
    const adapter = await initAdapter();
    const box = makeRecord();
    await adapter.createRecord(box);
    const record = makeRecord({ parentId: box.id });
    await adapter.createRecord(record);
    await adapter.setParent(record.id, null);
    const retrieved = await adapter.getRecord(record.id);
    expect(retrieved?.parentId).toBeUndefined();
    expect(retrieved?.version).toBe(1);
  });

  test('leaves content and associations untouched', async () => {
    const adapter = await initAdapter();
    const box = makeRecord();
    await adapter.createRecord(box);
    const record = makeRecord({
      content: { text: 'hello' },
      associations: [{ kind: 'tag', label: 'starred' }],
    });
    await adapter.createRecord(record);
    await adapter.setParent(record.id, box.id);
    const retrieved = await adapter.getRecord(record.id);
    expect(retrieved?.content).toEqual({ text: 'hello' });
    expect(retrieved?.associations).toEqual([{ kind: 'tag', label: 'starred' }]);
  });

  test('the moved record is found by a parentId query', async () => {
    const adapter = await initAdapter();
    const box = makeRecord();
    const record = makeRecord();
    await adapter.createRecord(box);
    await adapter.createRecord(record);
    await adapter.setParent(record.id, box.id);
    const result = await adapter.queryRecords(resolveQuery({ filter: { parentId: box.id } }));
    expect(result.records.map((r) => r.id)).toEqual([record.id]);
  });

  test('enforces ifVersion', async () => {
    const adapter = await initAdapter();
    const box = makeRecord();
    const record = makeRecord();
    await adapter.createRecord(box);
    await adapter.createRecord(record);
    await expect(adapter.setParent(record.id, box.id, { ifVersion: 99 })).rejects.toBeInstanceOf(
      StackVersionConflictError,
    );
    await adapter.setParent(record.id, box.id, { ifVersion: 1 });
  });
});

// -------------------------------------------------------
// Versions
// -------------------------------------------------------

describe('versions', () => {
  test('an imported version reads back through getVersion, actors included', async () => {
    const adapter = await initAdapter();
    const record = makeRecord({ version: 2 });
    const version = {
      version: 1,
      typeId: record.typeId,
      content: { text: 'original' },
      updatedAt: new Date('2024-01-01'),
      createdBy: { subjectId: 'entity-123' },
    };
    await adapter.importRecord(record, { versions: [version], journal: [] });
    const retrieved = await adapter.getVersion(record.id, 1);
    expect(retrieved?.content).toEqual({ text: 'original' });
    expect(retrieved?.createdBy?.subjectId).toBe('entity-123');
  });

  // The `versions` table has no parent_id column: containment bumps no
  // version, so no snapshot is ever taken of it. See sqlite-shared/src/schema.ts
  // and docs/spec/versioning.md § Version history.
  test('a snapshot carries no containment, however one is handed in', async () => {
    const adapter = await initAdapter();
    const record = makeRecord({ version: 3 });
    const base = { typeId: record.typeId, content: {}, updatedAt: new Date('2024-01-01') };
    await adapter.importRecord(record, {
      versions: [
        { ...base, version: 1 },
        { ...base, version: 2, ...({ parentId: 'box-1' } as Record<string, unknown>) },
      ],
      journal: [],
    });

    expect('parentId' in (await adapter.getVersion(record.id, 1))!).toBe(false);
    expect('parentId' in (await adapter.getVersion(record.id, 2))!).toBe(false);
  });

  test('restoreVersion leaves the record in the container it sits in', async () => {
    const adapter = await initAdapter();
    const box = makeRecord();
    await adapter.createRecord(box);
    const record = makeRecord({ version: 2, parentId: box.id });
    await adapter.importRecord(record, {
      versions: [
        {
          version: 1,
          typeId: record.typeId,
          content: { text: 'original' },
          updatedAt: new Date('2024-01-01'),
        },
      ],
      journal: [],
    });
    const restored = await adapter.restoreVersion(record.id, 1);
    expect(restored.content).toEqual({ text: 'original' });
    expect(restored.parentId).toBe(box.id);
    expect(
      (await adapter.queryRecords(resolveQuery({ filter: { parentId: box.id } }))).records,
    ).toHaveLength(1);
  });

  test('restoreVersion leaves a root record at the root', async () => {
    const adapter = await initAdapter();
    const box = makeRecord();
    await adapter.createRecord(box);
    const record = makeRecord({ version: 2 });
    await adapter.importRecord(record, {
      versions: [
        {
          version: 1,
          typeId: record.typeId,
          content: { text: 'original' },
          updatedAt: new Date('2024-01-01'),
        },
      ],
      journal: [],
    });
    const restored = await adapter.restoreVersion(record.id, 1);
    expect(restored.parentId).toBeUndefined();
    expect(
      (await adapter.queryRecords(resolveQuery({ filter: { parentId: null } }))).records,
    ).toHaveLength(2);
  });

  // Two snapshots at one version are outside the contract; they are here
  // only to make the engine fail after the record row is written.
  test('an import that fails part-way leaves no row behind', async () => {
    const adapter = await initAdapter();
    const record = makeRecord({ version: 2 });
    const v = { version: 1, typeId: record.typeId, content: {}, updatedAt: new Date() };
    await expect(adapter.importRecord(record, { versions: [v, v], journal: [] })).rejects.toThrow(
      StackConflictError,
    );
    expect(await adapter.getRecord(record.id)).toBeNull();
  });

  // A versions row at the record's own current version is an orphan: no
  // legitimate snapshot carries that number, since a snapshot commits
  // atomically with the bump past it. A stack carrying one — left by an
  // interrupted write — must heal rather than reject every future
  // mutation. See docs/spec/versioning.md § Snapshot atomicity.
  describe('orphan version row recovery', () => {
    test("a mutating call's snapshot heals a pre-existing orphan at the record's current version instead of colliding with it forever", async () => {
      const adapter = await initAdapter();
      const record = makeRecord({ version: 1, content: { text: 'original' } });
      await adapter.createRecord(record);
      // Simulate an interrupted write: the v1 snapshot committed, but the
      // mutation that should have bumped past it never did.
      plantVersionRow(record.id, {
        version: 1,
        typeId: record.typeId,
        content: { text: 'original' },
        updatedAt: record.updatedAt,
      });

      const updated = await adapter.patchContent(
        record.id,
        { text: 'healed' },
        {
          snapshot: {
            version: 1,
            typeId: record.typeId,
            content: { text: 'original' },
            updatedAt: record.updatedAt,
          },
        },
      );

      expect(updated.version).toBe(2);
      expect(updated.content).toEqual({ text: 'healed' });
      const versions = await adapter.getVersions(record.id);
      expect(versions).toHaveLength(1); // healed, not duplicated
      expect(versions[0].content).toEqual({ text: 'original' });
    });

    // The overwrite has to replace every column the insert writes. A column
    // left behind keeps the orphan's value and surfaces later as a restore
    // putting back something the healing snapshot never said.
    test('healing an orphan replaces every snapshot field, not just content', async () => {
      const adapter = await initAdapter();
      const record = makeRecord({ version: 1, content: { text: 'original' } });
      await adapter.createRecord(record);
      // The orphan carries an actor trail of its own alongside its content.
      plantVersionRow(record.id, {
        version: 1,
        typeId: record.typeId,
        content: { text: 'stale' },
        updatedAt: record.updatedAt,
        updatedBy: { subjectId: 'entity-stale', principalId: 'app-stale' },
      });

      await adapter.patchContent(
        record.id,
        { text: 'healed' },
        {
          snapshot: {
            version: 1,
            typeId: record.typeId,
            content: { text: 'original' },
            updatedAt: record.updatedAt,
          },
        },
      );

      const healed = await adapter.getVersion(record.id, 1);
      expect(healed?.content).toEqual({ text: 'original' });
      expect(healed?.updatedBy).toBeUndefined();
      expect(healed?.updatedBy?.principalId).toBeUndefined();

      const restored = await adapter.restoreVersion(record.id, 1);
      expect(restored.content).toEqual({ text: 'original' });
    });

    test('a snapshot for a version the record has already moved past is a genuine conflict, rejected with no partial apply', async () => {
      const adapter = await initAdapter();
      const record = makeRecord({ version: 1, content: { text: 'original' } });
      await adapter.createRecord(record);

      // Writer A completes first, bumping the record to v2 and legitimately
      // owning the v1 history slot.
      await adapter.patchContent(
        record.id,
        { text: 'from A' },
        {
          snapshot: {
            version: 1,
            typeId: record.typeId,
            content: { text: 'original' },
            updatedAt: record.updatedAt,
          },
        },
      );

      // Writer B built its mutation from the same stale v1 read. Its
      // snapshot attempt for v1 collides with A's real (not orphaned)
      // history entry — the record's current version is 2, not 1 — so it
      // must be rejected outright, not treated as recoverable.
      await expect(
        adapter.patchContent(
          record.id,
          { text: 'from B' },
          {
            snapshot: {
              version: 1,
              typeId: record.typeId,
              content: { text: 'original' },
              updatedAt: record.updatedAt,
            },
          },
        ),
      ).rejects.toThrow(StackConflictError);

      const current = await adapter.getRecord(record.id);
      expect(current?.content).toEqual({ text: 'from A' });
      expect(current?.version).toBe(2);
      const versions = await adapter.getVersions(record.id);
      expect(versions).toHaveLength(1); // B never wrote anything
    });
  });
});

describe('restoreVersion', () => {
  test('restores content and bumps version', async () => {
    const adapter = await initAdapter();
    const record = makeRecord({ version: 2, content: { text: 'changed' } });
    await adapter.importRecord(record, {
      versions: [
        {
          version: 1,
          typeId: record.typeId,
          content: { text: 'original' },
          updatedAt: new Date(),
        },
      ],
      journal: [],
    });

    const restored = await adapter.restoreVersion(record.id, 1);
    expect(restored.content).toEqual({ text: 'original' });
    expect(restored.version).toBe(3);
  });

  test('restored content is searchable and the pre-restore content is not', async () => {
    const adapter = await initAdapter();
    const record = makeRecord({ version: 2, content: { text: 'changed unrelated text' } });
    await adapter.importRecord(record, {
      versions: [
        {
          version: 1,
          typeId: record.typeId,
          content: { text: 'original searchable text' },
          updatedAt: new Date(),
        },
      ],
      journal: [],
    });

    await adapter.restoreVersion(record.id, 1);

    const findsOriginal = await adapter.queryRecords(
      resolveQuery({ filter: { search: 'searchable' } }),
    );
    expect(findsOriginal.records.map((r) => r.id)).toEqual([record.id]);
    const findsChanged = await adapter.queryRecords(
      resolveQuery({ filter: { search: 'unrelated' } }),
    );
    expect(findsChanged.records).toEqual([]);
  });

  test('throws for an unknown version', async () => {
    const adapter = await initAdapter();
    const record = makeRecord();
    await adapter.createRecord(record);
    await expect(adapter.restoreVersion(record.id, 99)).rejects.toThrow();
  });

  // RecordVersion carries no `associations` field at all — editAssociations()/
  // editAssociations() never bump, so no version ever snapshots the association
  // set, and restoreVersion() never writes to the associations table. See
  // StackRecordAdapter.restoreVersion() and docs/spec/versioning.md
  // § Version history.
  test('restoreVersion never touches associations — the current set survives untouched', async () => {
    const adapter = await initAdapter();
    const record = makeRecord({ version: 2 });
    await adapter.importRecord(record, {
      versions: [
        {
          version: 1,
          typeId: record.typeId,
          content: record.content,
          updatedAt: new Date(),
        },
      ],
      journal: [],
    });
    await adapter.setAssociations(record.id, [{ kind: 'tag', label: 'current' }]);

    const restored = await adapter.restoreVersion(record.id, 1);
    expect(restored.associations).toEqual([{ kind: 'tag', label: 'current' }]);
  });

  // Restoring content while the roster stays put is the shape a `_group`
  // restore takes; the adapter reaches it without knowing what a group is —
  // it never touches associations for any record.
  test('rolls content back while leaving associations in place', async () => {
    const adapter = await initAdapter();
    const record = makeRecord({ version: 2, content: { text: 'changed' } });
    await adapter.importRecord(record, {
      versions: [
        {
          version: 1,
          typeId: record.typeId,
          content: { text: 'original' },
          updatedAt: new Date(),
        },
      ],
      journal: [],
    });
    await adapter.setAssociations(record.id, [{ kind: 'tag', label: 'current' }]);

    const restored = await adapter.restoreVersion(record.id, 1);
    expect(restored.content).toEqual({ text: 'original' });
    expect(restored.associations).toEqual([{ kind: 'tag', label: 'current' }]);
  });

  test('restores typeId from the snapshot, even when it differs from the record’s current typeId', async () => {
    const adapter = await initAdapter();
    const record = makeRecord({ typeId: 'com.example.test/note@1', version: 2 });
    await adapter.importRecord(record, {
      versions: [
        {
          version: 1,
          typeId: 'com.example.test/note@1',
          content: { text: 'original' },
          updatedAt: new Date(),
        },
      ],
      journal: [],
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
  const ATTACHMENT_FAMILY = 'com.example.test/_attachment';
  const ATTACHMENT_TYPE = `${ATTACHMENT_FAMILY}@1`;

  test('throws StackConflictError when a record still references the file', async () => {
    const adapter = await initAdapter();
    const record = makeRecord();
    await adapter.createRecord(record);
    await adapter.editAssociations(record.id, [
      {
        op: 'add',
        association: {
          kind: 'attachment',
          label: 'cover',
          fileId: 'file-1',
        },
      },
    ]);

    await expect(
      adapter.deleteUnreferencedAttachmentRecords('file-1', ATTACHMENT_FAMILY),
    ).rejects.toThrow(StackConflictError);
  });

  test('returns the destroyed metadata record, not just its id', async () => {
    const adapter = await initAdapter();
    await adapter.createRecord(
      makeRecord({ id: 'meta1', typeId: ATTACHMENT_TYPE, content: { fileId: 'file-1' } }),
    );

    const deleted = await adapter.deleteUnreferencedAttachmentRecords('file-1', ATTACHMENT_FAMILY);
    // The last copy that will ever exist: after this call there is nothing
    // left to read the record's type or version back from.
    expect(deleted).toHaveLength(1);
    expect(deleted[0]!.id).toBe('meta1');
    expect(deleted[0]!.typeId).toBe(ATTACHMENT_TYPE);
    expect(deleted[0]!.version).toBe(1);
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
      ATTACHMENT_FAMILY,
    );
    expect(deleted.map((r) => r.id).sort()).toEqual(['meta1', 'meta2']);
  });

  test('deletes metadata records at every version of the family, and only that family', async () => {
    const adapter = await initAdapter();
    const ATTACHMENT_TYPE_V2 = 'com.example.test/_attachment@2';
    await adapter.createRecord(
      makeRecord({ id: 'meta1', typeId: ATTACHMENT_TYPE, content: { fileId: 'file-1' } }),
    );
    await adapter.createRecord(
      makeRecord({ id: 'meta2', typeId: ATTACHMENT_TYPE_V2, content: { fileId: 'file-1' } }),
    );
    await adapter.createRecord(
      makeRecord({
        id: 'other',
        typeId: 'com.example.test/_attachments@1',
        content: { fileId: 'file-1' },
      }),
    );

    const deleted = await adapter.deleteUnreferencedAttachmentRecords('file-1', ATTACHMENT_FAMILY);
    expect(deleted.map((r) => r.id).sort()).toEqual(['meta1', 'meta2']);
    expect(await adapter.getRecord('meta2')).toBeNull();
  });

  test('leaves a record outside the given family intact', async () => {
    const adapter = await initAdapter();
    await adapter.createRecord(
      makeRecord({
        id: 'meta1',
        typeId: 'com.example.test/other@1',
        content: { fileId: 'file-1' },
      }),
    );

    const deleted = await adapter.deleteUnreferencedAttachmentRecords('file-1', ATTACHMENT_FAMILY);
    expect(deleted).toEqual([]);
    expect(await adapter.getRecord('meta1')).not.toBeNull();
  });

  // The conflict is a fact about the file, not about which metadata records
  // happen to exist, so the reference check still runs.
  test('a family holding no metadata records still throws when the file is referenced', async () => {
    const adapter = await initAdapter();
    const record = makeRecord();
    await adapter.createRecord(record);
    await adapter.editAssociations(record.id, [
      {
        op: 'add',
        association: {
          kind: 'attachment',
          label: 'cover',
          fileId: 'file-1',
        },
      },
    ]);

    await expect(
      adapter.deleteUnreferencedAttachmentRecords('file-1', ATTACHMENT_FAMILY),
    ).rejects.toThrow(StackConflictError);
    expect(await adapter.deleteUnreferencedAttachmentRecords('file-2', ATTACHMENT_FAMILY)).toEqual(
      [],
    );
  });

  test('returns an empty array when no metadata records exist for the file', async () => {
    const adapter = await initAdapter();
    const deleted = await adapter.deleteUnreferencedAttachmentRecords(
      'nonexistent-file',
      ATTACHMENT_FAMILY,
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
    await adapter.editAssociations(referencing.id, [
      {
        op: 'add',
        association: {
          kind: 'attachment',
          label: 'cover',
          fileId: 'file-1',
        },
      },
    ]);

    await expect(
      adapter.deleteUnreferencedAttachmentRecords('file-1', ATTACHMENT_FAMILY),
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

// -------------------------------------------------------
// Actor attribution
// -------------------------------------------------------

describe('actor attribution', () => {
  const ACTOR = 'did:key:zActor';
  const OTHER = 'did:key:zOther';
  const APP = 'did:key:zApp';

  test('createRecord persists the actor columns', async () => {
    const adapter = await initAdapter();
    await adapter.saveType(NOTE_TYPE);
    const created = await adapter.createRecord(
      makeRecord({ createdBy: { subjectId: ACTOR }, updatedBy: { subjectId: ACTOR } }),
    );
    const read = await adapter.getRecord(created.id);
    expect(read?.updatedBy?.subjectId).toBe(ACTOR);
    expect(read?.updatedBy?.principalId).toBeUndefined();
    await adapter.close();
  });

  test('every version-bumping verb restamps the actor', async () => {
    const adapter = await initAdapter();
    await adapter.saveType(NOTE_TYPE);
    const r = await adapter.createRecord(
      makeRecord({ createdBy: { subjectId: ACTOR }, updatedBy: { subjectId: ACTOR } }),
    );

    await adapter.patchContent(
      r.id,
      { text: 'v2' },
      { actor: { subjectId: OTHER, principalId: APP } },
    );
    const read = await adapter.getRecord(r.id);
    expect([read?.updatedBy?.subjectId, read?.updatedBy?.principalId]).toEqual([OTHER, APP]);

    await adapter.deleteRecord(r.id, { actor: { subjectId: OTHER } });
    expect((await adapter.getRecord(r.id))?.updatedBy?.subjectId).toBe(OTHER);

    await adapter.undeleteRecord(r.id, { actor: { subjectId: ACTOR } });
    expect((await adapter.getRecord(r.id))?.updatedBy?.subjectId).toBe(ACTOR);

    await adapter.commitMigration(
      r.id,
      'com.example.test/note@1',
      { text: 'm' },
      {
        actor: { subjectId: OTHER },
      },
    );
    expect((await adapter.getRecord(r.id))?.updatedBy?.subjectId).toBe(OTHER);
    await adapter.close();
  });

  // The writes that never bump take no ActorOptions at all: there is no
  // version for an actor to be stamped on. See
  // docs/spec/versioning.md § Version history.
  test('association writes never restamp the actor', async () => {
    const adapter = await initAdapter();
    await adapter.saveType(NOTE_TYPE);
    const r = await adapter.createRecord(
      makeRecord({ createdBy: { subjectId: ACTOR }, updatedBy: { subjectId: ACTOR } }),
    );

    await adapter.editAssociations(r.id, [{ op: 'add', association: { kind: 'tag', label: 'x' } }]);
    expect((await adapter.getRecord(r.id))?.updatedBy?.subjectId).toBe(ACTOR);

    await adapter.editAssociations(r.id, [
      { op: 'remove', association: { kind: 'tag', label: 'x' } },
    ]);
    expect((await adapter.getRecord(r.id))?.updatedBy?.subjectId).toBe(ACTOR);
    await adapter.close();
  });

  test('a mutation naming no actor clears the previous one', async () => {
    const adapter = await initAdapter();
    await adapter.saveType(NOTE_TYPE);
    const r = await adapter.createRecord(
      makeRecord({ createdBy: { subjectId: ACTOR }, updatedBy: { subjectId: ACTOR } }),
    );

    await adapter.patchContent(r.id, { text: 'v2' });

    const read = await adapter.getRecord(r.id);
    expect(read?.updatedBy).toBeUndefined();
    expect(read?.createdBy?.subjectId).toBe(ACTOR);
    await adapter.close();
  });

  test('version snapshots round-trip the actor', async () => {
    const adapter = await initAdapter();
    await adapter.saveType(NOTE_TYPE);
    const r = await adapter.createRecord(
      makeRecord({ createdBy: { subjectId: ACTOR }, updatedBy: { subjectId: ACTOR } }),
    );

    await adapter.patchContent(
      r.id,
      { text: 'v2' },
      {
        actor: { subjectId: OTHER },
        snapshot: {
          version: 1,
          typeId: r.typeId,
          content: r.content,
          updatedAt: r.updatedAt,
          createdBy: { subjectId: ACTOR, principalId: APP },
          updatedBy: { subjectId: ACTOR, principalId: APP },
        },
      },
    );

    const [v1] = await adapter.getVersions(r.id);
    expect(v1.createdBy).toEqual({ subjectId: ACTOR, principalId: APP });
    expect(v1.updatedBy).toEqual({ subjectId: ACTOR, principalId: APP });
    await adapter.close();
  });

  test('restoreVersion stamps the restorer, not the restored version', async () => {
    const adapter = await initAdapter();
    await adapter.saveType(NOTE_TYPE);
    const r = await adapter.createRecord(
      makeRecord({ createdBy: { subjectId: ACTOR }, updatedBy: { subjectId: ACTOR } }),
    );

    await adapter.patchContent(
      r.id,
      { text: 'v2' },
      {
        actor: { subjectId: OTHER },
        snapshot: {
          version: 1,
          typeId: r.typeId,
          content: r.content,
          updatedAt: r.updatedAt,
          createdBy: { subjectId: ACTOR },
          updatedBy: { subjectId: ACTOR },
        },
      },
    );

    await adapter.restoreVersion(r.id, 1, { actor: { subjectId: APP } });

    const read = await adapter.getRecord(r.id);
    expect(read?.content.text).toBe('Hello world');
    expect(read?.updatedBy?.subjectId).toBe(APP);
    await adapter.close();
  });
});
