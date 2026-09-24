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
import type { AuthorityAssociation, StackRecord } from '@haverstack/core';

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
    const updated = await adapter.mutateRecord(record.id, { contentPatch: { text: 'Updated' } });
    expect(updated.content).toEqual({ text: 'Updated' });
    expect(updated.version).toBe(2);
  });

  test('patchContent preserves unchanged fields', async () => {
    const adapter = await initAdapter();
    const record = makeRecord({ parentId: 'parent-abc' });
    await adapter.createRecord(record);
    await adapter.mutateRecord(record.id, { contentPatch: { text: 'Updated' } });
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
    const updated = await adapter.mutateRecord(
      record.id,
      { contentPatch: { text: 'Updated' } },
      { expectedVersion: 1 },
    );
    expect(updated.version).toBe(2);
    expect(updated.content).toEqual({ text: 'Updated' });
  });

  test('patchContent throws StackVersionConflictError and changes nothing when stale', async () => {
    const adapter = await initAdapter();
    const record = await adapter.createRecord(makeRecord());
    await adapter.mutateRecord(record.id, { contentPatch: { text: 'first' } }); // -> v2

    const err = await adapter
      .mutateRecord(record.id, { contentPatch: { text: 'second' } }, { expectedVersion: 1 })
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
      .mutateRecord(
        record.id,
        { contentPatch: { text: 'rejected update' } },
        { expectedVersion: 999 },
      )
      .catch(() => {});

    const stillFindsOriginal = await adapter.queryRecords({ filter: { search: 'original' } });
    expect(stillFindsOriginal.records.map((r) => r.id)).toEqual([record.id]);
    const doesNotFindRejected = await adapter.queryRecords({ filter: { search: 'rejected' } });
    expect(doesNotFindRejected.records).toEqual([]);
  });

  test('soft deleteRecord and undeleteRecord enforce expectedVersion', async () => {
    const adapter = await initAdapter();
    const record = await adapter.createRecord(makeRecord());
    await adapter.mutateRecord(record.id, { contentPatch: { text: 'v2' } }); // -> v2

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

  test('commitMigration enforces expectedVersion and leaves typeId untouched on mismatch', async () => {
    const adapter = await initAdapter();
    const record = await adapter.createRecord(makeRecord({ content: { text: 'original' } }));
    await adapter.mutateRecord(record.id, { contentPatch: { text: 'v2' } }); // -> v2

    await expect(
      adapter.commitMigration(
        record.id,
        'com.example/note@2',
        { text: 'migrated' },
        {
          expectedVersion: 1,
        },
      ),
    ).rejects.toBeInstanceOf(StackVersionConflictError);
    const untouched = await adapter.getRecord(record.id);
    expect(untouched?.typeId).toBe(record.typeId);
    expect(untouched?.version).toBe(2);
    // The rejected write must not have disturbed the FTS index either.
    const stillFindsV2 = await adapter.queryRecords({ filter: { search: 'v2' } });
    expect(stillFindsV2.records.map((r) => r.id)).toEqual([record.id]);

    const migrated = await adapter.commitMigration(
      record.id,
      'com.example/note@2',
      { text: 'migrated' },
      { expectedVersion: 2 },
    ); // -> v3
    expect(migrated.typeId).toBe('com.example/note@2');
    expect(migrated.version).toBe(3);
  });

  test('hard deleteRecord enforces expectedVersion and leaves the record untouched on mismatch', async () => {
    const adapter = await initAdapter();
    const record = await adapter.createRecord(makeRecord());
    await adapter.mutateRecord(record.id, { contentPatch: { text: 'v2' } }); // -> v2

    await expect(
      adapter.deleteRecord(record.id, { hard: true, expectedVersion: 1 }),
    ).rejects.toBeInstanceOf(StackVersionConflictError);
    expect(await adapter.getRecord(record.id)).not.toBeNull();

    await adapter.deleteRecord(record.id, { hard: true, expectedVersion: 2 });
    expect(await adapter.getRecord(record.id)).toBeNull();
  });

  test('associate and dissociate take no expectedVersion and never bump', async () => {
    const adapter = await initAdapter();
    const record = await adapter.createRecord(makeRecord());

    await adapter.associate(record.id, { kind: 'tag', label: 'x' });
    await adapter.dissociate(record.id, { kind: 'tag', label: 'x' });

    expect((await adapter.getRecord(record.id))?.version).toBe(1);
  });

  // mutateRecord's non-bumping path (opts.bumpsVersion: false — what a
  // caller passes for an associations-only change set) re-checks
  // expectedVersion against a fresh read inside its own transaction,
  // since there is no version-bumping UPDATE for the guard to ride in.
  // That read can come back null if a concurrent hard delete lands
  // between mutateRecord's own read and this re-check; the adapter must
  // report that as StackNotFoundError like every other write path here,
  // not crash on it.
  test('mutateRecord with bumpsVersion: false reports StackNotFoundError, not a crash, for a concurrently deleted record', async () => {
    const adapter = await initAdapter();
    const record = await adapter.createRecord(makeRecord());

    const logic = (
      adapter as unknown as {
        record: { getRecord: (id: string) => Promise<StackRecord | null> };
      }
    ).record;
    const originalGetRecord = logic.getRecord.bind(logic);
    vi.spyOn(logic, 'getRecord').mockImplementationOnce(async (id: string) => {
      const found = await originalGetRecord(id);
      await adapter.deleteRecord(id, { hard: true }); // races mutateRecord's own no-bump re-read
      return found;
    });

    await expect(
      adapter.mutateRecord(
        record.id,
        { associations: [{ kind: 'tag', label: 'x' }] },
        { bumpsVersion: false, expectedVersion: 1 },
      ),
    ).rejects.toBeInstanceOf(StackNotFoundError);
  });

  test('a permissions change set enforces expectedVersion', async () => {
    const adapter = await initAdapter();
    const record = await adapter.createRecord(makeRecord());

    await expect(
      adapter.mutateRecord(
        record.id,
        { permissions: [{ kind: 'anyone', label: 'read' }] },
        { expectedVersion: 99 },
      ),
    ).rejects.toBeInstanceOf(StackVersionConflictError);

    await adapter.mutateRecord(
      record.id,
      { permissions: [{ kind: 'anyone', label: 'read' }] },
      { expectedVersion: 1 },
    );
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
    await adapter.mutateRecord(record.id, { contentPatch: { text: 'v2' } }); // -> v2

    await expect(
      adapter.restoreVersion(record.id, 1, { expectedVersion: 1 }),
    ).rejects.toBeInstanceOf(StackVersionConflictError);

    const restored = await adapter.restoreVersion(record.id, 1, { expectedVersion: 2 }); // -> v3
    expect(restored.version).toBe(3);
    expect(restored.content).toEqual({ text: 'original' });
  });

  test('associate on a nonexistent record throws StackNotFoundError', async () => {
    const adapter = await initAdapter();
    await expect(adapter.associate('nonexistent', { kind: 'tag', label: 'x' })).rejects.toThrow(
      StackNotFoundError,
    );
  });
});

// -------------------------------------------------------
// expectedVersion — enforced against the row actually written
// -------------------------------------------------------

/**
 * restoreVersion() and commitMigration() settle their precondition against
 * a record read before the transaction opens, because fts5Strategy.remove()
 * needs the old content still on the row. That read is not the enforcement:
 * the UPDATE carries the guard too, so a writer landing in the window loses
 * rather than being silently overwritten.
 *
 * The window is reachable from a test because both methods `await` that
 * read: calling one runs its body up to the await and hands control back
 * here with the precondition already satisfied, so the next synchronous
 * statement below lands squarely between the check and the write.
 */
describe('expectedVersion is re-checked by the statement that writes', () => {
  /**
   * A second writer, on its own connection — the adapter holds a lock
   * *file*, which only initialize()/open() consult, so this is the real
   * race rather than a stand-in for one.
   */
  const bumpVersionBehindTheAdapter = (id: string): void => {
    const other = new DatabaseSync(dbPath);
    try {
      other.prepare('UPDATE records SET version = version + 1 WHERE id = ?').run(id);
    } finally {
      other.close();
    }
  };

  test('restoreVersion loses to a writer that lands after the precondition check', async () => {
    const adapter = await initAdapter();
    const record = await adapter.createRecord(makeRecord({ content: { text: 'original' } }));
    await adapter.saveVersion(record.id, {
      version: 1,
      typeId: record.typeId,
      content: { text: 'original' },
      updatedAt: record.updatedAt,
    });
    await adapter.mutateRecord(record.id, { contentPatch: { text: 'v2' } }); // -> v2

    const restoring = adapter.restoreVersion(record.id, 1, { expectedVersion: 2 });
    bumpVersionBehindTheAdapter(record.id); // -> v3, after the check, before the write

    const err = await restoring.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StackVersionConflictError);
    expect((err as StackVersionConflictError).actualVersion).toBe(3);

    // And the restore left nothing behind: the content the other writer
    // found is the content still there.
    const after = await adapter.getRecord(record.id);
    expect(after?.content).toEqual({ text: 'v2' });
    expect(after?.version).toBe(3);
  });

  test('commitMigration loses to a writer that lands after the precondition check', async () => {
    const adapter = await initAdapter();
    const record = await adapter.createRecord(makeRecord({ content: { text: 'original' } }));

    const migrating = adapter.commitMigration(
      record.id,
      'com.example/note@2',
      { text: 'migrated' },
      { expectedVersion: 1 },
    );
    bumpVersionBehindTheAdapter(record.id); // -> v2, after the check, before the write

    const err = await migrating.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StackVersionConflictError);
    expect((err as StackVersionConflictError).actualVersion).toBe(2);

    const after = await adapter.getRecord(record.id);
    expect(after?.typeId).toBe(record.typeId);
    expect(after?.content).toEqual({ text: 'original' });
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
    const result = await adapter.queryRecords({});
    expect(result.records.length).toBe(2);
  });

  test('includeDeleted returns soft-deleted records', async () => {
    const adapter = await initAdapter();
    const record = makeRecord();
    await adapter.createRecord(record);
    await adapter.deleteRecord(record.id);
    const result = await adapter.queryRecords({ filter: { includeDeleted: true } });
    expect(result.records.some((r) => r.id === record.id)).toBe(true);
  });

  test('excludes unlisted records by default, and includeUnlisted returns them', async () => {
    const adapter = await initAdapter();
    const record = makeRecord();
    await adapter.createRecord(record);
    await adapter.mutateRecord(record.id, { unlisted: true });

    const excluded = await adapter.queryRecords({});
    expect(excluded.records.some((r) => r.id === record.id)).toBe(false);

    const included = await adapter.queryRecords({ filter: { includeUnlisted: true } });
    expect(included.records.some((r) => r.id === record.id)).toBe(true);
  });

  // The order clause and the cursor comparison interpolate sort.direction
  // straight into SQL. Core's assertValidSort() is the primary guard, but
  // the builder re-checks so a caller reaching the adapter directly cannot
  // inject through a raw direction string.
  test('a sort direction outside asc/desc is refused at the SQL boundary', async () => {
    const adapter = await initAdapter();
    await adapter.createRecord(makeRecord({ id: 'r1' }));
    await expect(
      adapter.queryRecords({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        sort: { field: 'createdAt', direction: 'ASC, (SELECT 1)' as any },
      }),
    ).rejects.toThrow(StackQueryError);
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

  // a null content filter means "field absent or null," never "match
  // nothing" — plain SQL `= NULL` is always false, so this needs IS NULL /
  // missing-path semantics to match at all.
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

  // Presence is what an exact-match value cannot ask: a value matches what
  // is there, never whether anything is.
  test('contentPresent matches records holding a value at the path', async () => {
    const adapter = await initAdapter();
    await adapter.createRecord(makeRecord({ id: 'r1', content: { text: 'dated', at: '2021' } }));
    await adapter.createRecord(makeRecord({ id: 'r2', content: { text: 'undated' } }));
    await adapter.createRecord(makeRecord({ id: 'r3', content: { text: 'null', at: null } }));

    const present = await adapter.queryRecords({ filter: { contentPresent: ['at'] } });
    expect(present.records.map((r) => r.id)).toEqual(['r1']);

    const absent = await adapter.queryRecords({ filter: { content: { at: null } } });
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

    const result = await adapter.queryRecords({ filter: { contentPresent: ['emails.value'] } });
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

    const result = await adapter.queryRecords({
      filter: { contentPresent: ['at'], content: { kind: 'post' } },
      sort: { contentField: 'text', direction: 'asc' },
    });
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
    const result = await adapter.queryRecords({ filter: { content: { tags: 'starred' } } });
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
    const result = await adapter.queryRecords({
      filter: { content: { 'address.city': 'Lisbon' } },
    });
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
    const byValue = await adapter.queryRecords({
      filter: { content: { 'emails.value': 'a@work.example' } },
    });
    expect(byValue.records.map((r) => r.id)).toEqual(['r1']);

    const byLabel = await adapter.queryRecords({ filter: { content: { 'emails.label': 'work' } } });
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
    const result = await adapter.queryRecords({ filter: { content: { 'a.b.c': 7 } } });
    expect(result.records.map((r) => r.id)).toEqual(['r1']);
  });

  test('a dotted filter key is a path, never a literal field name', async () => {
    const adapter = await initAdapter();
    await adapter.createRecord(makeRecord({ id: 'r1', content: { text: 'nested', a: { b: 1 } } }));
    const result = await adapter.queryRecords({ filter: { content: { 'a.b': 1 } } });
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
    const result = await adapter.queryRecords({ filter: { content: { 'address.city': null } } });
    expect(result.records.map((r) => r.id).sort()).toEqual(['r1', 'r2', 'r3']);
  });

  test('a filter path descending through a scalar matches nothing', async () => {
    const adapter = await initAdapter();
    await adapter.createRecord(makeRecord({ id: 'r1', content: { text: 'a', a: 'hello' } }));
    const result = await adapter.queryRecords({ filter: { content: { 'a.b': 'hello' } } });
    expect(result.records).toEqual([]);
  });

  test('a filter path segment carrying a reserved character is refused', async () => {
    const adapter = await initAdapter();
    await expect(
      adapter.queryRecords({ filter: { content: { 'emails[0]': 'x' } } }),
    ).rejects.toThrow(StackQueryError);
    await expect(adapter.queryRecords({ filter: { content: { 'a..b': 'x' } } })).rejects.toThrow(
      StackQueryError,
    );
  });

  test('two content filters both apply', async () => {
    const adapter = await initAdapter();
    await adapter.createRecord(
      makeRecord({ id: 'r1', content: { text: 'a', a: { b: 1 }, c: 'yes' } }),
    );
    await adapter.createRecord(
      makeRecord({ id: 'r2', content: { text: 'b', a: { b: 1 }, c: 'no' } }),
    );
    const result = await adapter.queryRecords({
      filter: { content: { 'a.b': 1, c: 'yes' } },
    });
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

    const result = await adapter.queryRecords({ filter: { content: { [key]: 'hit' } } });
    expect(result.records.map((r) => r.id)).toEqual(['r1']);
  });

  // A key carrying path syntax is a structural fault in the request,
  // answered as StackQueryError (400) rather than reaching the engine as a
  // malformed path and escaping as a raw error.
  test('a key that is not path-shaped is refused, never an engine error', async () => {
    const adapter = await initAdapter();
    await adapter.createRecord(makeRecord({ id: 'r1', content: { text: 'present' } }));

    for (const key of ['$.', '[', '"', 'a[0', '', 'a..b', '*', '#']) {
      await expect(adapter.queryRecords({ filter: { content: { [key]: 'x' } } })).rejects.toThrow(
        StackQueryError,
      );
    }
  });

  // The segment cap is what keeps the generated join list inside SQLite's
  // 64-table limit, so the longest legal path has to be executable, not
  // merely accepted. See docs/spec/data-model.md § Nested content paths.
  test('a path at the segment cap executes; one past it is refused', async () => {
    const adapter = await initAdapter();
    const deepest = Array.from({ length: 32 }, (_, i) => `s${i}`).join('.');
    await adapter.createRecord(makeRecord({ id: 'r1', content: { text: 'shallow' } }));

    await expect(
      adapter.queryRecords({ filter: { content: { [deepest]: 'x' } } }),
    ).resolves.toMatchObject({ records: [] });
    await expect(
      adapter.queryRecords({ filter: { content: { [deepest]: null } } }),
    ).resolves.toMatchObject({ records: [{ id: 'r1' }] });
    await expect(
      adapter.queryRecords({ filter: { content: { [`${deepest}.s32`]: 'x' } } }),
    ).rejects.toThrow(StackQueryError);
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

    const nested = await adapter.queryRecords({
      filter: { content: { 'a.b': '{"k":"v"}' } },
    });
    expect(nested.records).toEqual([]);
    const top = await adapter.queryRecords({ filter: { content: { obj: '{"k":"v"}' } } });
    expect(top.records).toEqual([]);
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

  // a search term that sanitizes to nothing (here, a bare wildcard
  // FTS5 strips outright) must match nothing, not silently drop the search
  // clause and return the whole table as the "search result".
  test('a search term that sanitizes to empty matches nothing, not everything', async () => {
    const adapter = await initAdapter();
    await adapter.createRecord(makeRecord({ id: 'r1', content: { text: 'SQLite is great' } }));
    await adapter.createRecord(
      makeRecord({ id: 'r2', content: { text: 'Postgres is also great' } }),
    );
    const result = await adapter.queryRecords({ filter: { search: '*' } });
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
    await expect(adapter.queryRecords({ filter: { search } })).resolves.toBeDefined();
  });

  test('a repaired search still finds its terms', async () => {
    const adapter = await initAdapter();
    await adapter.createRecord(makeRecord({ id: 'r1', content: { text: 'SQLite is great' } }));
    await adapter.createRecord(
      makeRecord({ id: 'r2', content: { text: 'Postgres is also great' } }),
    );
    const result = await adapter.queryRecords({ filter: { search: 'SQLite AND' } });
    expect(result.records.map((r) => r.id)).toEqual(['r1']);
  });

  // The backstop behind the sanitizer, which claims no completeness
  // against FTS5's grammar: whatever reaches the engine and fails to parse
  // is a bad_request, never a raw engine error a server has no code to map.
  test('search text the engine cannot parse raises StackQueryError', async () => {
    const adapter = await initAdapter();
    await adapter.createRecord(makeRecord({ id: 'r1', content: { text: 'SQLite is great' } }));
    // Reach past the sanitizer to stand in for a grammar case it misses.
    vi.spyOn(execOf(adapter), 'all').mockImplementation(() => {
      throw new Error('fts5: syntax error near ""');
    });
    await expect(adapter.queryRecords({ filter: { search: 'anything' } })).rejects.toThrow(
      StackQueryError,
    );
  });

  test('a non-search query failure is not relabelled as a bad request', async () => {
    const adapter = await initAdapter();
    vi.spyOn(execOf(adapter), 'all').mockImplementation(() => {
      throw new Error('database disk image is malformed');
    });
    await expect(adapter.queryRecords({ filter: { typeId: 'x/y@1' } })).rejects.toThrow(
      'database disk image is malformed',
    );
  });

  test('full-text search reflects patchContent updates (not stale index entries)', async () => {
    const adapter = await initAdapter();
    const record = makeRecord({ content: { text: 'original content here' } });
    await adapter.createRecord(record);
    await adapter.mutateRecord(record.id, { contentPatch: { text: 'updated content here' } });

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
    await adapter.mutateRecord('r1', { contentPatch: { coverFileId: 'file-2' } });

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
      adapter.deleteUnreferencedAttachmentRecords('file-1', [ATTACHMENT_TYPE]),
    ).rejects.toThrow(StackConflictError);
    expect(await adapter.getRecord('meta1')).not.toBeNull();
  });

  // The fields content_index covers are cached per typeId (keyed off
  // saveType()) so that syncContentIndex() doesn't re-query and re-parse the
  // schema on every write — this pins that redefining a type reaches the
  // cache.
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
    await adapter.mutateRecord('r1', { contentPatch: { coverFileId: 'file-1' } });

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
    // dissociating the only association omits the key entirely
    // (undefined), never a bare `[]` — this is the shape MemoryAdapter must
    // match too, since it's what a fresh record's snapshot also uses.
    expect(retrieved?.associations).toBeUndefined();
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

  test('associate never bumps version', async () => {
    const adapter = await initAdapter();
    const record = makeRecord();
    await adapter.createRecord(record);
    await adapter.associate(record.id, { kind: 'tag', label: 'starred' });
    const retrieved = await adapter.getRecord(record.id);
    expect(retrieved?.version).toBe(1);
  });

  test('associate on a nonexistent record throws StackNotFoundError instead of creating an orphan row', async () => {
    const adapter = await initAdapter();
    await expect(
      adapter.associate('does-not-exist', { kind: 'tag', label: 'starred' }),
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

    await adapter.associate(record.id, association);

    expect((await adapter.getRecord(record.id))?.associations).toEqual([association]);
  });

  test('an attachment association with no pointer omits the key', async () => {
    const adapter = await initAdapter();
    const record = makeRecord();
    await adapter.createRecord(record);
    const association = { kind: 'attachment' as const, label: 'embed', fileId: 'a'.repeat(64) };

    await adapter.associate(record.id, association);

    expect((await adapter.getRecord(record.id))?.associations).toEqual([association]);
  });

  // attachment_record_id sits outside the primary key, so a re-pointed
  // association lands on the row already there.
  test('re-pointing an attachment association updates the one row', async () => {
    const adapter = await initAdapter();
    const record = makeRecord();
    await adapter.createRecord(record);
    const fileId = 'a'.repeat(64);
    await adapter.associate(record.id, {
      kind: 'attachment',
      label: 'embed',
      fileId,
      attachmentRecordId: '1hk153x00001',
    });

    await adapter.associate(record.id, {
      kind: 'attachment',
      label: 'embed',
      fileId,
      attachmentRecordId: '1hk153x00002',
    });

    expect((await adapter.getRecord(record.id))?.associations).toEqual([
      { kind: 'attachment', label: 'embed', fileId, attachmentRecordId: '1hk153x00002' },
    ]);
  });

  test('re-associating without a pointer clears the column', async () => {
    const adapter = await initAdapter();
    const record = makeRecord();
    await adapter.createRecord(record);
    const fileId = 'a'.repeat(64);
    await adapter.associate(record.id, {
      kind: 'attachment',
      label: 'embed',
      fileId,
      attachmentRecordId: '1hk153x00001',
    });

    await adapter.associate(record.id, { kind: 'attachment', label: 'embed', fileId });

    expect((await adapter.getRecord(record.id))?.associations).toEqual([
      { kind: 'attachment', label: 'embed', fileId },
    ]);
  });

  test('every target arm round-trips through storage', async () => {
    const adapter = await initAdapter();
    const record = makeRecord();
    await adapter.createRecord(record);
    const targets = [
      { scope: 'record' as const, recordId: 'rec-other' },
      { scope: 'record' as const, recordId: 'rec-other', stackUrl: 'https://alice.example/stack' },
      { scope: 'entity' as const, entityId: 'did:key:z6MkAlice' },
      { scope: 'external' as const, ns: 'atproto', id: 'at://did:plc:abc/app.bsky.feed.post/3k4' },
    ];
    for (const target of targets) {
      await adapter.associate(record.id, { kind: 'relationship', label: 'ref', target });
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
    await adapter.associate(record.id, {
      kind: 'relationship',
      label: 'syndicated-to',
      target: { scope: 'external', ns: 'atproto', id: 'copy-1' },
    });
    await adapter.associate(record.id, {
      kind: 'relationship',
      label: 'syndicated-to',
      target: { scope: 'external', ns: 'activitypub', id: 'copy-1' },
    });

    const retrieved = await adapter.getRecord(record.id);
    expect(retrieved?.associations).toHaveLength(2);
  });

  test('dissociate removes only the target it names', async () => {
    const adapter = await initAdapter();
    const record = makeRecord();
    await adapter.createRecord(record);
    await adapter.associate(record.id, {
      kind: 'relationship',
      label: 'syndicated-to',
      target: { scope: 'external', ns: 'atproto', id: 'copy-1' },
    });
    await adapter.associate(record.id, {
      kind: 'relationship',
      label: 'syndicated-to',
      target: { scope: 'external', ns: 'activitypub', id: 'copy-1' },
    });
    await adapter.dissociate(record.id, {
      kind: 'relationship',
      label: 'syndicated-to',
      target: { scope: 'external', ns: 'atproto', id: 'copy-1' },
    });

    const retrieved = await adapter.getRecord(record.id);
    expect(retrieved?.associations).toEqual([
      {
        kind: 'relationship',
        label: 'syndicated-to',
        target: { scope: 'external', ns: 'activitypub', id: 'copy-1' },
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
    await adapter.associate(series.id, {
      kind: 'relationship',
      label: 'series',
      target: { scope: 'record', recordId: 'rec-subject' },
    });
    await adapter.associate(syndicated.id, {
      kind: 'relationship',
      label: 'syndicated-to',
      target: { scope: 'external', ns: 'atproto', id: 'at://did:plc:abc/app.bsky.feed.post/3k4' },
    });
    await adapter.associate(authored.id, {
      kind: 'relationship',
      label: 'author',
      target: { scope: 'entity', entityId: 'did:key:z6MkAlice' },
    });
  };

  const ids = (result: { records: StackRecord[] }) => result.records.map((r) => r.id).sort();

  test('matches a record target', async () => {
    const adapter = await initAdapter();
    await seed(adapter);
    const result = await adapter.queryRecords({
      filter: { relatedTo: { target: { scope: 'record', recordId: 'rec-subject' } } },
    });
    expect(ids(result)).toEqual(['rec-series']);
  });

  test('matches an entity target', async () => {
    const adapter = await initAdapter();
    await seed(adapter);
    const result = await adapter.queryRecords({
      filter: { relatedTo: { target: { scope: 'entity', entityId: 'did:key:z6MkAlice' } } },
    });
    expect(ids(result)).toEqual(['rec-authored']);
  });

  test('an external target without an id matches the whole namespace', async () => {
    const adapter = await initAdapter();
    await seed(adapter);
    const result = await adapter.queryRecords({
      filter: { relatedTo: { target: { scope: 'external', ns: 'atproto' } } },
    });
    expect(ids(result)).toEqual(['rec-syndicated']);
  });

  test('a bare label matches every target under it', async () => {
    const adapter = await initAdapter();
    await seed(adapter);
    const result = await adapter.queryRecords({ filter: { relatedTo: { label: 'author' } } });
    expect(ids(result)).toEqual(['rec-authored']);
  });

  // An entity target and a record target holding the same string are
  // different references — the distinction group rosters rest on.
  test('a record target does not match an entity target with the same value', async () => {
    const adapter = await initAdapter();
    await seed(adapter);
    const result = await adapter.queryRecords({
      filter: { relatedTo: { target: { scope: 'record', recordId: 'did:key:z6MkAlice' } } },
    });
    expect(result.records).toHaveLength(0);
  });

  // An absent stackUrl names this stack rather than acting as a wildcard.
  test('a local record target does not match the same id in another stack', async () => {
    const adapter = await initAdapter();
    await seed(adapter);
    const remote = makeRecord({ id: 'rec-remote' });
    await adapter.createRecord(remote);
    await adapter.associate(remote.id, {
      kind: 'relationship',
      label: 'reply-to',
      target: {
        scope: 'record',
        recordId: 'rec-elsewhere',
        stackUrl: 'https://alice.example/stack',
      },
    });

    const local = await adapter.queryRecords({
      filter: { relatedTo: { target: { scope: 'record', recordId: 'rec-elsewhere' } } },
    });
    expect(local.records).toHaveLength(0);

    const scoped = await adapter.queryRecords({
      filter: {
        relatedTo: {
          target: {
            scope: 'record',
            recordId: 'rec-elsewhere',
            stackUrl: 'https://alice.example/stack',
          },
        },
      },
    });
    expect(ids(scoped)).toEqual(['rec-remote']);
  });
});

// -------------------------------------------------------
// Permissions
// -------------------------------------------------------

describe('mutateRecord — the `permissions` key', () => {
  test('replaces permissions', async () => {
    const adapter = await initAdapter();
    const record = makeRecord();
    await adapter.createRecord(record);
    await adapter.mutateRecord(record.id, { permissions: [{ kind: 'anyone', label: 'read' }] });
    const retrieved = await adapter.getRecord(record.id);
    expect(retrieved?.permissions).toEqual([{ kind: 'anyone', label: 'read' }]);
  });

  // Both fields project one table, so the only thing keeping a tag write
  // off an ACL is the kind partition the two keys replace within.
  test('each key replaces only its own half of the association table', async () => {
    const adapter = await initAdapter();
    const record = makeRecord({
      associations: [{ kind: 'tag', label: 'draft' }],
      permissions: [{ kind: 'anyone', label: 'read' }],
    });
    await adapter.createRecord(record);

    await adapter.mutateRecord(record.id, { associations: [{ kind: 'tag', label: 'reviewed' }] });
    const afterTags = await adapter.getRecord(record.id);
    expect(afterTags?.associations).toEqual([{ kind: 'tag', label: 'reviewed' }]);
    expect(afterTags?.permissions).toEqual([{ kind: 'anyone', label: 'read' }]);

    await adapter.mutateRecord(record.id, { permissions: [] });
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
    await adapter.mutateRecord(record.id, { permissions });
    // Row order is the table's, not the write's: both are stored, which is
    // what the key column buys.
    expect((await adapter.getRecord(record.id))?.permissions).toEqual(
      expect.arrayContaining(permissions),
    );
    expect((await adapter.getRecord(record.id))?.permissions).toHaveLength(2);
  });

  // associate()/dissociate() key all kinds alike, which is what
  // grantAccess()/revokeAccess() ride on.
  test('associate/dissociate carry an authority element like any other', async () => {
    const adapter = await initAdapter();
    const record = makeRecord({ associations: [{ kind: 'tag', label: 'draft' }] });
    await adapter.createRecord(record);

    const grant: AuthorityAssociation = {
      kind: 'permission',
      label: 'read',
      grantee: { kind: 'entity', entityId: 'did:key:z6MkMember' },
    };
    const granted = await adapter.associate(record.id, grant);
    expect(granted.permissions).toEqual([grant]);
    expect(granted.associations).toEqual([{ kind: 'tag', label: 'draft' }]);

    const revoked = await adapter.dissociate(record.id, grant);
    expect(revoked.permissions).toBeUndefined();
    expect(revoked.associations).toEqual([{ kind: 'tag', label: 'draft' }]);
  });
});

describe('mutateRecord — the `unlisted` key', () => {
  test('sets unlistedAt and bumps version', async () => {
    const adapter = await initAdapter();
    const record = makeRecord();
    await adapter.createRecord(record);
    await adapter.mutateRecord(record.id, { unlisted: true });
    const retrieved = await adapter.getRecord(record.id);
    expect(retrieved?.unlistedAt).toBeInstanceOf(Date);
    expect(retrieved?.version).toBe(2);
  });

  test('clears unlistedAt on the reverse call', async () => {
    const adapter = await initAdapter();
    const record = makeRecord();
    await adapter.createRecord(record);
    await adapter.mutateRecord(record.id, { unlisted: true });
    await adapter.mutateRecord(record.id, { unlisted: false });
    const retrieved = await adapter.getRecord(record.id);
    expect(retrieved?.unlistedAt).toBeUndefined();
    expect(retrieved?.version).toBe(3);
  });

  test('enforces expectedVersion', async () => {
    const adapter = await initAdapter();
    const record = makeRecord();
    await adapter.createRecord(record);
    await expect(
      adapter.mutateRecord(record.id, { unlisted: true }, { expectedVersion: 99 }),
    ).rejects.toBeInstanceOf(StackVersionConflictError);
    await adapter.mutateRecord(record.id, { unlisted: true }, { expectedVersion: 1 });
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
    const roots = await adapter.queryRecords({ filter: { parentId: null } });
    expect(roots.records.map((r) => r.id)).not.toContain(record.id);
  });

  test('a parentId of an empty string stores it rather than clearing the parent', async () => {
    const adapter = await initAdapter();
    const box = makeRecord();
    await adapter.createRecord(box);
    const record = makeRecord({ parentId: box.id });
    await adapter.createRecord(record);
    await adapter.mutateRecord(record.id, { parentId: '' });
    expect((await adapter.getRecord(record.id))?.parentId).toBe('');
  });

  test('a deletedAt at the epoch reads back as a tombstone', async () => {
    const adapter = await initAdapter();
    const record = makeRecord({ deletedAt: new Date(0) });
    await adapter.createRecord(record);
    expect((await adapter.getRecord(record.id))?.deletedAt).toEqual(new Date(0));
    // The query predicate already excluded it; now getRecord() agrees.
    const live = await adapter.queryRecords({});
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
    const record = makeRecord({ entityId: '', appId: '', updatedBy: '' });
    await adapter.createRecord(record);
    const retrieved = await adapter.getRecord(record.id);
    expect(retrieved?.entityId).toBe('');
    expect(retrieved?.appId).toBe('');
    expect(retrieved?.updatedBy).toBe('');
  });
});

describe('mutateRecord — the `parentId` key', () => {
  test('sets parent_id and bumps version', async () => {
    const adapter = await initAdapter();
    const box = makeRecord();
    const record = makeRecord();
    await adapter.createRecord(box);
    await adapter.createRecord(record);
    await adapter.mutateRecord(record.id, { parentId: box.id });
    const retrieved = await adapter.getRecord(record.id);
    expect(retrieved?.parentId).toBe(box.id);
    expect(retrieved?.version).toBe(2);
  });

  test('null clears parent_id', async () => {
    const adapter = await initAdapter();
    const box = makeRecord();
    await adapter.createRecord(box);
    const record = makeRecord({ parentId: box.id });
    await adapter.createRecord(record);
    await adapter.mutateRecord(record.id, { parentId: null });
    const retrieved = await adapter.getRecord(record.id);
    expect(retrieved?.parentId).toBeUndefined();
    expect(retrieved?.version).toBe(2);
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
    await adapter.mutateRecord(record.id, { parentId: box.id });
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
    await adapter.mutateRecord(record.id, { parentId: box.id });
    const result = await adapter.queryRecords({ filter: { parentId: box.id } });
    expect(result.records.map((r) => r.id)).toEqual([record.id]);
  });

  test('enforces expectedVersion', async () => {
    const adapter = await initAdapter();
    const box = makeRecord();
    const record = makeRecord();
    await adapter.createRecord(box);
    await adapter.createRecord(record);
    await expect(
      adapter.mutateRecord(record.id, { parentId: box.id }, { expectedVersion: 99 }),
    ).rejects.toBeInstanceOf(StackVersionConflictError);
    await adapter.mutateRecord(record.id, { parentId: box.id }, { expectedVersion: 1 });
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

  // The `versions` table has no parent_id column: containment bumps no
  // version, so no snapshot is ever taken of it. See sqlite-shared/src/schema.ts
  // and docs/spec/versioning.md § Version history.
  test('a snapshot carries no containment, however one is handed in', async () => {
    const adapter = await initAdapter();
    const record = makeRecord();
    await adapter.createRecord(record);
    const base = { typeId: record.typeId, content: {}, updatedAt: new Date('2024-01-01') };
    await adapter.saveVersion(record.id, { ...base, version: 1 });
    await adapter.saveVersion(record.id, {
      ...base,
      version: 2,
      ...({ parentId: 'box-1' } as Record<string, unknown>),
    });

    expect('parentId' in (await adapter.getVersion(record.id, 1))!).toBe(false);
    expect('parentId' in (await adapter.getVersion(record.id, 2))!).toBe(false);
  });

  test('restoreVersion leaves the record in the container it sits in', async () => {
    const adapter = await initAdapter();
    const box = makeRecord();
    await adapter.createRecord(box);
    const record = makeRecord({ version: 2, parentId: box.id });
    await adapter.createRecord(record);
    await adapter.saveVersion(record.id, {
      version: 1,
      typeId: record.typeId,
      content: { text: 'original' },
      updatedAt: new Date('2024-01-01'),
    });
    const restored = await adapter.restoreVersion(record.id, 1);
    expect(restored.content).toEqual({ text: 'original' });
    expect(restored.parentId).toBe(box.id);
    expect((await adapter.queryRecords({ filter: { parentId: box.id } })).records).toHaveLength(1);
  });

  test('restoreVersion leaves a root record at the root', async () => {
    const adapter = await initAdapter();
    const box = makeRecord();
    await adapter.createRecord(box);
    const record = makeRecord({ version: 2 });
    await adapter.createRecord(record);
    await adapter.saveVersion(record.id, {
      version: 1,
      typeId: record.typeId,
      content: { text: 'original' },
      updatedAt: new Date('2024-01-01'),
    });
    const restored = await adapter.restoreVersion(record.id, 1);
    expect(restored.parentId).toBeUndefined();
    expect((await adapter.queryRecords({ filter: { parentId: null } })).records).toHaveLength(2);
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
      await adapter.saveVersion(record.id, {
        version: 1,
        typeId: record.typeId,
        content: { text: 'original' },
        updatedAt: record.updatedAt,
      });

      const updated = await adapter.mutateRecord(
        record.id,
        { contentPatch: { text: 'healed' } },
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
      await adapter.saveVersion(record.id, {
        version: 1,
        typeId: record.typeId,
        content: { text: 'stale' },
        updatedAt: record.updatedAt,
        updatedBy: 'entity-stale',
        updatedVia: 'app-stale',
      });

      await adapter.mutateRecord(
        record.id,
        { contentPatch: { text: 'healed' } },
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
      expect(healed?.updatedVia).toBeUndefined();

      const restored = await adapter.restoreVersion(record.id, 1);
      expect(restored.content).toEqual({ text: 'original' });
    });

    test('a snapshot for a version the record has already moved past is a genuine conflict, rejected with no partial apply', async () => {
      const adapter = await initAdapter();
      const record = makeRecord({ version: 1, content: { text: 'original' } });
      await adapter.createRecord(record);

      // Writer A completes first, bumping the record to v2 and legitimately
      // owning the v1 history slot.
      await adapter.mutateRecord(
        record.id,
        { contentPatch: { text: 'from A' } },
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
        adapter.mutateRecord(
          record.id,
          { contentPatch: { text: 'from B' } },
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
    const record = makeRecord();
    await adapter.createRecord(record);
    await adapter.saveVersion(record.id, {
      version: 1,
      typeId: record.typeId,
      content: { text: 'original' },
      updatedAt: new Date(),
    });
    await adapter.mutateRecord(record.id, { contentPatch: { text: 'changed' } });

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
    await adapter.mutateRecord(record.id, { contentPatch: { text: 'changed unrelated text' } });

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

  // RecordVersion carries no `associations` field at all — associate()/
  // dissociate() never bump, so no version ever snapshots the association
  // set, and restoreVersion() never writes to the associations table. See
  // StackRecordAdapter.restoreVersion() and docs/spec/versioning.md
  // § Version history.
  test('restoreVersion never touches associations — the current set survives untouched', async () => {
    const adapter = await initAdapter();
    const record = makeRecord();
    await adapter.createRecord(record);
    await adapter.saveVersion(record.id, {
      version: 1,
      typeId: record.typeId,
      content: record.content,
      updatedAt: new Date(),
    });
    await adapter.mutateRecord(record.id, { associations: [{ kind: 'tag', label: 'current' }] });

    const restored = await adapter.restoreVersion(record.id, 1);
    expect(restored.associations).toEqual([{ kind: 'tag', label: 'current' }]);
  });

  // Restoring content while the roster stays put is the shape a `_group`
  // restore takes; the adapter reaches it without knowing what a group is —
  // it never touches associations for any record.
  test('rolls content back while leaving associations in place', async () => {
    const adapter = await initAdapter();
    const record = makeRecord({ content: { text: 'original' } });
    await adapter.createRecord(record);
    await adapter.saveVersion(record.id, {
      version: 1,
      typeId: record.typeId,
      content: { text: 'original' },
      updatedAt: new Date(),
    });
    await adapter.mutateRecord(record.id, {
      contentPatch: { text: 'changed' },
      associations: [{ kind: 'tag', label: 'current' }],
    });

    const restored = await adapter.restoreVersion(record.id, 1);
    expect(restored.content).toEqual({ text: 'original' });
    expect(restored.associations).toEqual([{ kind: 'tag', label: 'current' }]);
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
    });

    await expect(
      adapter.deleteUnreferencedAttachmentRecords('file-1', [ATTACHMENT_TYPE]),
    ).rejects.toThrow(StackConflictError);
  });

  test('returns the destroyed metadata record, not just its id', async () => {
    const adapter = await initAdapter();
    await adapter.createRecord(
      makeRecord({ id: 'meta1', typeId: ATTACHMENT_TYPE, content: { fileId: 'file-1' } }),
    );

    const deleted = await adapter.deleteUnreferencedAttachmentRecords('file-1', [ATTACHMENT_TYPE]);
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

    const deleted = await adapter.deleteUnreferencedAttachmentRecords('shared-file', [
      ATTACHMENT_TYPE,
    ]);
    expect(deleted.map((r) => r.id).sort()).toEqual(['meta1', 'meta2']);
  });

  test('deletes metadata records across every typeId it is given', async () => {
    const adapter = await initAdapter();
    const ATTACHMENT_TYPE_V2 = 'com.example.test/_attachment@2';
    await adapter.createRecord(
      makeRecord({ id: 'meta1', typeId: ATTACHMENT_TYPE, content: { fileId: 'file-1' } }),
    );
    await adapter.createRecord(
      makeRecord({ id: 'meta2', typeId: ATTACHMENT_TYPE_V2, content: { fileId: 'file-1' } }),
    );

    const deleted = await adapter.deleteUnreferencedAttachmentRecords('file-1', [
      ATTACHMENT_TYPE,
      ATTACHMENT_TYPE_V2,
    ]);
    expect(deleted.map((r) => r.id).sort()).toEqual(['meta1', 'meta2']);
    expect(await adapter.getRecord('meta2')).toBeNull();
  });

  test('leaves a record of a typeId outside the given set intact', async () => {
    const adapter = await initAdapter();
    await adapter.createRecord(
      makeRecord({
        id: 'meta1',
        typeId: 'com.example.test/_attachment@2',
        content: { fileId: 'file-1' },
      }),
    );

    const deleted = await adapter.deleteUnreferencedAttachmentRecords('file-1', [ATTACHMENT_TYPE]);
    expect(deleted).toEqual([]);
    expect(await adapter.getRecord('meta1')).not.toBeNull();
  });

  // The conflict is a fact about the file, not about which metadata types
  // happen to be defined, so the reference check still runs.
  test('an empty typeId set still throws when the file is referenced', async () => {
    const adapter = await initAdapter();
    const record = makeRecord();
    await adapter.createRecord(record);
    await adapter.associate(record.id, {
      kind: 'attachment',
      label: 'cover',
      fileId: 'file-1',
    });

    await expect(adapter.deleteUnreferencedAttachmentRecords('file-1', [])).rejects.toThrow(
      StackConflictError,
    );
    expect(await adapter.deleteUnreferencedAttachmentRecords('file-2', [])).toEqual([]);
  });

  test('returns an empty array when no metadata records exist for the file', async () => {
    const adapter = await initAdapter();
    const deleted = await adapter.deleteUnreferencedAttachmentRecords('nonexistent-file', [
      ATTACHMENT_TYPE,
    ]);
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
    });

    await expect(
      adapter.deleteUnreferencedAttachmentRecords('file-1', [ATTACHMENT_TYPE]),
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
    const created = await adapter.createRecord(makeRecord({ entityId: ACTOR, updatedBy: ACTOR }));
    const read = await adapter.getRecord(created.id);
    expect(read?.updatedBy).toBe(ACTOR);
    expect(read?.updatedVia).toBeUndefined();
    await adapter.close();
  });

  test('every version-bumping verb restamps the actor', async () => {
    const adapter = await initAdapter();
    await adapter.saveType(NOTE_TYPE);
    const r = await adapter.createRecord(makeRecord({ entityId: ACTOR, updatedBy: ACTOR }));

    await adapter.mutateRecord(
      r.id,
      { contentPatch: { text: 'v2' } },
      { updatedBy: OTHER, updatedVia: APP },
    );
    const read = await adapter.getRecord(r.id);
    expect([read?.updatedBy, read?.updatedVia]).toEqual([OTHER, APP]);

    await adapter.mutateRecord(
      r.id,
      { permissions: [{ kind: 'anyone', label: 'read' }] },
      { updatedBy: ACTOR },
    );
    expect((await adapter.getRecord(r.id))?.updatedBy).toBe(ACTOR);

    await adapter.deleteRecord(r.id, { updatedBy: OTHER });
    expect((await adapter.getRecord(r.id))?.updatedBy).toBe(OTHER);

    await adapter.undeleteRecord(r.id, { updatedBy: ACTOR });
    expect((await adapter.getRecord(r.id))?.updatedBy).toBe(ACTOR);

    await adapter.commitMigration(
      r.id,
      'com.example.test/note@1',
      { text: 'm' },
      {
        updatedBy: OTHER,
      },
    );
    expect((await adapter.getRecord(r.id))?.updatedBy).toBe(OTHER);
    await adapter.close();
  });

  // associate()/dissociate() take no ActorOptions at all — they never bump,
  // so there is no version for an actor to be stamped on. See
  // docs/spec/versioning.md § Version history.
  test('associate()/dissociate() never restamp the actor', async () => {
    const adapter = await initAdapter();
    await adapter.saveType(NOTE_TYPE);
    const r = await adapter.createRecord(makeRecord({ entityId: ACTOR, updatedBy: ACTOR }));

    await adapter.associate(r.id, { kind: 'tag', label: 'x' });
    expect((await adapter.getRecord(r.id))?.updatedBy).toBe(ACTOR);

    await adapter.dissociate(r.id, { kind: 'tag', label: 'x' });
    expect((await adapter.getRecord(r.id))?.updatedBy).toBe(ACTOR);
    await adapter.close();
  });

  test('a mutation naming no actor clears the previous one', async () => {
    const adapter = await initAdapter();
    await adapter.saveType(NOTE_TYPE);
    const r = await adapter.createRecord(makeRecord({ entityId: ACTOR, updatedBy: ACTOR }));

    await adapter.mutateRecord(r.id, { contentPatch: { text: 'v2' } }, {});

    const read = await adapter.getRecord(r.id);
    expect(read?.updatedBy).toBeUndefined();
    expect(read?.entityId).toBe(ACTOR);
    await adapter.close();
  });

  test('version snapshots round-trip the actor', async () => {
    const adapter = await initAdapter();
    await adapter.saveType(NOTE_TYPE);
    const r = await adapter.createRecord(makeRecord({ entityId: ACTOR, updatedBy: ACTOR }));

    await adapter.mutateRecord(
      r.id,
      { contentPatch: { text: 'v2' } },
      {
        updatedBy: OTHER,
        snapshot: {
          version: 1,
          typeId: r.typeId,
          content: r.content,
          updatedAt: r.updatedAt,
          entityId: ACTOR,
          updatedBy: ACTOR,
          updatedVia: APP,
        },
      },
    );

    const [v1] = await adapter.getVersions(r.id);
    expect(v1.entityId).toBe(ACTOR);
    expect(v1.updatedBy).toBe(ACTOR);
    expect(v1.updatedVia).toBe(APP);
    await adapter.close();
  });

  test('restoreVersion stamps the restorer, not the restored version', async () => {
    const adapter = await initAdapter();
    await adapter.saveType(NOTE_TYPE);
    const r = await adapter.createRecord(makeRecord({ entityId: ACTOR, updatedBy: ACTOR }));

    await adapter.mutateRecord(
      r.id,
      { contentPatch: { text: 'v2' } },
      {
        updatedBy: OTHER,
        snapshot: {
          version: 1,
          typeId: r.typeId,
          content: r.content,
          updatedAt: r.updatedAt,
          entityId: ACTOR,
          updatedBy: ACTOR,
        },
      },
    );

    await adapter.restoreVersion(r.id, 1, { updatedBy: APP });

    const read = await adapter.getRecord(r.id);
    expect(read?.content.text).toBe('Hello world');
    expect(read?.updatedBy).toBe(APP);
    await adapter.close();
  });
});
