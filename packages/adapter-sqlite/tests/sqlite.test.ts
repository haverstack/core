import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { SQLiteAdapter } from '../src/index.js';
import type { StackRecord } from '@haverstack/core';

// -------------------------------------------------------
// Test helpers
// -------------------------------------------------------

let testDir: string;
let dbPath: string;

beforeEach(() => {
  testDir = join(tmpdir(), `stack-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(testDir, { recursive: true });
  dbPath = join(testDir, 'test.db');
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

const initAdapter = (opts?: { timezone?: string; entityId?: string }) =>
  SQLiteAdapter.initialize({
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

  test('creates an attachments directory', async () => {
    await initAdapter();
    expect(existsSync(join(testDir, 'attachments'))).toBe(true);
  });

  test('stores entity_id in config', async () => {
    const adapter = await initAdapter({ entityId: 'owner-abc' });
    expect(await adapter.getConfig('entity_id')).toBe('owner-abc');
  });

  test('stores timezone in config', async () => {
    const adapter = await initAdapter({ timezone: 'Europe/London' });
    expect(await adapter.getConfig('timezone')).toBe('Europe/London');
  });

  test('stores version in config', async () => {
    const adapter = await initAdapter();
    expect(await adapter.getConfig('version')).toBe('1');
  });

  test('throws if database already exists', async () => {
    await initAdapter();
    await expect(initAdapter()).rejects.toThrow(/already exists/);
  });
});

describe('open', () => {
  test('opens an existing database', async () => {
    await initAdapter();
    const adapter = await SQLiteAdapter.open({ path: dbPath });
    expect(await adapter.getConfig('entity_id')).toBe('entity-123');
  });

  test('throws if database does not exist', async () => {
    await expect(SQLiteAdapter.open({ path: join(testDir, 'nonexistent.db') })).rejects.toThrow(
      /no database found/,
    );
  });

  test('data persists across adapter instances', async () => {
    const adapter1 = await initAdapter();
    await adapter1.saveType(NOTE_TYPE);
    const record = makeRecord();
    await adapter1.createRecord(record);

    // Open fresh instance — data should still be there
    const adapter2 = await SQLiteAdapter.open({ path: dbPath });
    expect(await adapter2.getType(NOTE_TYPE.id)).not.toBeNull();
    expect(await adapter2.getRecord(record.id)).not.toBeNull();
  });
});

// -------------------------------------------------------
// Config
// -------------------------------------------------------

describe('config', () => {
  test('setConfig stores a value', async () => {
    const adapter = await initAdapter();
    await adapter.setConfig('custom_key', 'custom_value');
    expect(await adapter.getConfig('custom_key')).toBe('custom_value');
  });

  test('setConfig overwrites existing value', async () => {
    const adapter = await initAdapter({ timezone: 'UTC' });
    await adapter.setConfig('timezone', 'Asia/Tokyo');
    expect(await adapter.getConfig('timezone')).toBe('Asia/Tokyo');
  });

  test('getConfig returns null for missing key', async () => {
    const adapter = await initAdapter();
    expect(await adapter.getConfig('nonexistent')).toBeNull();
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

  test('updateRecord changes specified fields', async () => {
    const adapter = await initAdapter();
    const record = makeRecord();
    await adapter.createRecord(record);
    const now = new Date();
    const updated = await adapter.updateRecord(record.id, {
      content: { text: 'Updated' },
      version: 2,
      updatedAt: now,
    });
    expect(updated.content).toEqual({ text: 'Updated' });
    expect(updated.version).toBe(2);
  });

  test('updateRecord preserves unchanged fields', async () => {
    const adapter = await initAdapter();
    const record = makeRecord({ parentId: 'parent-abc' });
    await adapter.createRecord(record);
    await adapter.updateRecord(record.id, { version: 2, updatedAt: new Date() });
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
      content: record.content,
      updatedAt: record.updatedAt,
    });
    await adapter.deleteRecord(record.id, { hard: true });
    expect(await adapter.getVersions(record.id)).toEqual([]);
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
    await adapter.deleteRecord(r3.id); // soft delete
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

  test('filters by multiple typeIds', async () => {
    const adapter = await initAdapter();
    await adapter.createRecord(makeRecord({ id: 'r1', typeId: 'com.example/note@1' }));
    await adapter.createRecord(makeRecord({ id: 'r2', typeId: 'com.example/note@2' }));
    await adapter.createRecord(makeRecord({ id: 'r3', typeId: 'com.example/task@1' }));
    const result = await adapter.queryRecords({
      filter: { typeId: ['com.example/note@1', 'com.example/note@2'] },
    });
    expect(result.records.length).toBe(2);
  });

  test('filters by parentId', async () => {
    const adapter = await initAdapter();
    const parent = makeRecord({ id: 'parent' });
    const child1 = makeRecord({ id: 'child1', parentId: 'parent' });
    const child2 = makeRecord({ id: 'child2', parentId: 'parent' });
    const other = makeRecord({ id: 'other' });
    await adapter.createRecord(parent);
    await adapter.createRecord(child1);
    await adapter.createRecord(child2);
    await adapter.createRecord(other);
    const result = await adapter.queryRecords({ filter: { parentId: 'parent' } });
    expect(result.records.length).toBe(2);
    expect(result.records.every((r) => r.parentId === 'parent')).toBe(true);
  });

  test('parentId: null returns root records only', async () => {
    const adapter = await initAdapter();
    await adapter.createRecord(makeRecord({ id: 'root1' }));
    await adapter.createRecord(makeRecord({ id: 'root2' }));
    await adapter.createRecord(makeRecord({ id: 'child', parentId: 'root1' }));
    const result = await adapter.queryRecords({ filter: { parentId: null } });
    expect(result.records.every((r) => !r.parentId)).toBe(true);
    expect(result.records.length).toBe(2);
  });

  test('filters by appId', async () => {
    const adapter = await initAdapter();
    await adapter.createRecord(makeRecord({ id: 'r1', appId: 'app-a' }));
    await adapter.createRecord(makeRecord({ id: 'r2', appId: 'app-b' }));
    const result = await adapter.queryRecords({ filter: { appId: 'app-a' } });
    expect(result.records.length).toBe(1);
    expect(result.records[0].appId).toBe('app-a');
  });

  test('filters by createdAt range', async () => {
    const adapter = await initAdapter();
    const early = makeRecord({ id: 'early', createdAt: new Date('2024-01-01') });
    const late = makeRecord({ id: 'late', createdAt: new Date('2024-06-01') });
    await adapter.createRecord(early);
    await adapter.createRecord(late);
    const result = await adapter.queryRecords({
      filter: { createdAt: { after: new Date('2024-03-01') } },
    });
    expect(result.records.length).toBe(1);
    expect(result.records[0].id).toBe('late');
  });

  test('filters by tag', async () => {
    const adapter = await initAdapter();
    const tagged = makeRecord({ id: 'tagged' });
    const untagged = makeRecord({ id: 'untagged' });
    await adapter.createRecord(tagged);
    await adapter.createRecord(untagged);
    await adapter.associate(tagged.id, { kind: 'tag', label: 'favourite' });
    const result = await adapter.queryRecords({ filter: { tags: ['favourite'] } });
    expect(result.records.length).toBe(1);
    expect(result.records[0].id).toBe('tagged');
  });

  test('tag filter requires ALL tags', async () => {
    const adapter = await initAdapter();
    const both = makeRecord({ id: 'both' });
    const one = makeRecord({ id: 'one' });
    await adapter.createRecord(both);
    await adapter.createRecord(one);
    await adapter.associate(both.id, { kind: 'tag', label: 'a' });
    await adapter.associate(both.id, { kind: 'tag', label: 'b' });
    await adapter.associate(one.id, { kind: 'tag', label: 'a' });
    const result = await adapter.queryRecords({ filter: { tags: ['a', 'b'] } });
    expect(result.records.length).toBe(1);
    expect(result.records[0].id).toBe('both');
  });

  test('filters by hasAttachment label', async () => {
    const adapter = await initAdapter();
    const withDiagram = makeRecord({ id: 'with-diagram' });
    const without = makeRecord({ id: 'without' });
    await adapter.createRecord(withDiagram);
    await adapter.createRecord(without);
    await adapter.associate(withDiagram.id, {
      kind: 'attachment',
      label: 'diagram',
      fileId: 'file-1',
      mimeType: 'image/png',
    });
    const result = await adapter.queryRecords({ filter: { hasAttachment: 'diagram' } });
    expect(result.records.length).toBe(1);
    expect(result.records[0].id).toBe('with-diagram');
  });

  test('filters by attachmentFileId', async () => {
    const adapter = await initAdapter();
    const withFile = makeRecord({ id: 'with-file' });
    const otherFile = makeRecord({ id: 'other-file' });
    const noFile = makeRecord({ id: 'no-file' });
    await adapter.createRecord(withFile);
    await adapter.createRecord(otherFile);
    await adapter.createRecord(noFile);
    await adapter.associate(withFile.id, {
      kind: 'attachment',
      label: 'cover',
      fileId: 'target-file-id',
      mimeType: 'image/png',
    });
    await adapter.associate(otherFile.id, {
      kind: 'attachment',
      label: 'cover',
      fileId: 'different-file-id',
      mimeType: 'image/png',
    });
    const result = await adapter.queryRecords({
      filter: { attachmentFileId: 'target-file-id' },
    });
    expect(result.records.length).toBe(1);
    expect(result.records[0].id).toBe('with-file');
  });

  test('attachmentFileId filter returns multiple records sharing a file', async () => {
    const adapter = await initAdapter();
    const r1 = makeRecord({ id: 'r1' });
    const r2 = makeRecord({ id: 'r2' });
    const r3 = makeRecord({ id: 'r3' });
    await adapter.createRecord(r1);
    await adapter.createRecord(r2);
    await adapter.createRecord(r3);
    await adapter.associate(r1.id, {
      kind: 'attachment',
      label: 'photo',
      fileId: 'shared-file',
      mimeType: 'image/jpeg',
    });
    await adapter.associate(r2.id, {
      kind: 'attachment',
      label: 'thumbnail',
      fileId: 'shared-file',
      mimeType: 'image/jpeg',
    });
    const result = await adapter.queryRecords({ filter: { attachmentFileId: 'shared-file' } });
    const ids = result.records.map((r) => r.id).sort();
    expect(ids).toEqual(['r1', 'r2']);
    expect(result.total).toBe(2);
  });

  test('attachmentFileId filter returns empty when no records reference the file', async () => {
    const adapter = await initAdapter();
    await adapter.createRecord(makeRecord({ id: 'r1' }));
    const result = await adapter.queryRecords({
      filter: { attachmentFileId: 'nonexistent-file-id' },
    });
    expect(result.records.length).toBe(0);
    expect(result.total).toBe(0);
  });

  test('filters by relatedTo', async () => {
    const adapter = await initAdapter();
    const source = makeRecord({ id: 'source' });
    const related = makeRecord({ id: 'related' });
    const other = makeRecord({ id: 'other' });
    await adapter.createRecord(source);
    await adapter.createRecord(related);
    await adapter.createRecord(other);
    await adapter.associate(related.id, {
      kind: 'relationship',
      label: 'see-also',
      recordId: source.id,
    });
    const result = await adapter.queryRecords({ filter: { relatedTo: { recordId: source.id } } });
    expect(result.records.length).toBe(1);
    expect(result.records[0].id).toBe('related');
  });

  test('filters by content field', async () => {
    const adapter = await initAdapter();
    await adapter.createRecord(makeRecord({ id: 'r1', content: { text: 'alpha', priority: 1 } }));
    await adapter.createRecord(makeRecord({ id: 'r2', content: { text: 'beta', priority: 2 } }));
    const result = await adapter.queryRecords({ filter: { content: { priority: 1 } } });
    expect(result.records.length).toBe(1);
    expect(result.records[0].id).toBe('r1');
  });

  test('full-text search', async () => {
    const adapter = await initAdapter();
    await adapter.createRecord(makeRecord({ id: 'r1', content: { text: 'SQLite is great' } }));
    await adapter.createRecord(
      makeRecord({ id: 'r2', content: { text: 'Postgres is also great' } }),
    );
    const result = await adapter.queryRecords({ filter: { search: 'SQLite' } });
    expect(result.records.length).toBe(1);
    expect(result.records[0].id).toBe('r1');
  });

  test('cursor pagination returns correct pages', async () => {
    const adapter = await initAdapter();
    for (let i = 0; i < 5; i++) {
      await adapter.createRecord(
        makeRecord({
          id: `r${i}`,
          createdAt: new Date(Date.now() + i * 1000),
        }),
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

    // No overlap
    const page1Ids = new Set(page1.records.map((r) => r.id));
    const page2Ids = new Set(page2.records.map((r) => r.id));
    expect([...page1Ids].filter((id) => page2Ids.has(id)).length).toBe(0);
  });

  test('cursor pagination works correctly when sorted by updatedAt', async () => {
    const adapter = await initAdapter();
    for (let i = 1; i <= 5; i++) {
      await adapter.createRecord(
        makeRecord({
          id: `r${i}`,
          createdAt: new Date(i * 1000),
          updatedAt: new Date((6 - i) * 1000),
        }),
      );
    }

    const page1 = await adapter.queryRecords({
      sort: { field: 'updatedAt', direction: 'asc' },
      limit: 3,
    });
    expect(page1.records.length).toBe(3);
    expect(page1.cursor).not.toBeNull();

    const page2 = await adapter.queryRecords({
      sort: { field: 'updatedAt', direction: 'asc' },
      limit: 3,
      cursor: page1.cursor!,
    });
    expect(page2.records.length).toBe(2);
    expect(page2.cursor).toBeNull();

    const allIds = new Set([...page1.records, ...page2.records].map((r) => r.id));
    expect(allIds.size).toBe(5);
  });

  test('cursor pagination works correctly when sorted by version', async () => {
    const adapter = await initAdapter();
    for (let i = 1; i <= 5; i++) {
      await adapter.createRecord(
        makeRecord({
          id: `r${i}`,
          createdAt: new Date(i * 1000),
          version: 6 - i,
        }),
      );
    }

    const page1 = await adapter.queryRecords({
      sort: { field: 'version', direction: 'asc' },
      limit: 3,
    });
    expect(page1.records.length).toBe(3);
    expect(page1.cursor).not.toBeNull();

    const page2 = await adapter.queryRecords({
      sort: { field: 'version', direction: 'asc' },
      limit: 3,
      cursor: page1.cursor!,
    });
    expect(page2.records.length).toBe(2);
    expect(page2.cursor).toBeNull();

    const allIds = new Set([...page1.records, ...page2.records].map((r) => r.id));
    expect(allIds.size).toBe(5);
  });

  test('sort by createdAt descending (default)', async () => {
    const adapter = await initAdapter();
    await adapter.createRecord(makeRecord({ id: 'r1', createdAt: new Date(1000) }));
    await adapter.createRecord(makeRecord({ id: 'r2', createdAt: new Date(2000) }));
    await adapter.createRecord(makeRecord({ id: 'r3', createdAt: new Date(3000) }));
    const result = await adapter.queryRecords({ sort: { field: 'createdAt', direction: 'desc' } });
    expect(result.records.map((r) => r.id)).toEqual(['r3', 'r2', 'r1']);
  });

  test('sort by createdAt ascending', async () => {
    const adapter = await initAdapter();
    await adapter.createRecord(makeRecord({ id: 'r1', createdAt: new Date(1000) }));
    await adapter.createRecord(makeRecord({ id: 'r2', createdAt: new Date(2000) }));
    await adapter.createRecord(makeRecord({ id: 'r3', createdAt: new Date(3000) }));
    const result = await adapter.queryRecords({ sort: { field: 'createdAt', direction: 'asc' } });
    expect(result.records.map((r) => r.id)).toEqual(['r1', 'r2', 'r3']);
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

  test('associate adds an attachment', async () => {
    const adapter = await initAdapter();
    const record = makeRecord();
    await adapter.createRecord(record);
    await adapter.associate(record.id, {
      kind: 'attachment',
      label: 'avatar',
      fileId: 'file-xyz',
      mimeType: 'image/jpeg',
    });
    const retrieved = await adapter.getRecord(record.id);
    const assoc = retrieved?.associations?.find((a) => a.kind === 'attachment');
    expect(assoc).toBeDefined();
    if (assoc?.kind === 'attachment') {
      expect(assoc.fileId).toBe('file-xyz');
      expect(assoc.mimeType).toBe('image/jpeg');
    }
  });

  test('associate adds a relationship', async () => {
    const adapter = await initAdapter();
    const r1 = makeRecord({ id: 'r1' });
    const r2 = makeRecord({ id: 'r2' });
    await adapter.createRecord(r1);
    await adapter.createRecord(r2);
    await adapter.associate(r2.id, { kind: 'relationship', label: 'reply-to', recordId: r1.id });
    const retrieved = await adapter.getRecord(r2.id);
    const assoc = retrieved?.associations?.find((a) => a.kind === 'relationship');
    expect(assoc).toBeDefined();
    if (assoc?.kind === 'relationship') {
      expect(assoc.recordId).toBe(r1.id);
      expect(assoc.label).toBe('reply-to');
    }
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

  test('multiple associations on a record all roundtrip', async () => {
    const adapter = await initAdapter();
    const record = makeRecord();
    await adapter.createRecord(record);
    await adapter.associate(record.id, { kind: 'tag', label: 'starred' });
    await adapter.associate(record.id, { kind: 'tag', label: 'pinned' });
    await adapter.associate(record.id, {
      kind: 'attachment',
      label: 'cover',
      fileId: 'f1',
      mimeType: 'image/png',
    });
    const retrieved = await adapter.getRecord(record.id);
    expect(retrieved?.associations?.length).toBe(3);
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
      content: { text: 'original' },
      updatedAt: new Date('2024-01-01'),
      entityId: 'entity-123',
    };
    await adapter.saveVersion(record.id, version);
    const retrieved = await adapter.getVersion(record.id, 1);
    expect(retrieved?.content).toEqual({ text: 'original' });
    expect(retrieved?.entityId).toBe('entity-123');
    expect(retrieved?.updatedAt).toBeInstanceOf(Date);
  });

  test('getVersions returns all versions in descending order', async () => {
    const adapter = await initAdapter();
    const record = makeRecord();
    await adapter.createRecord(record);
    await adapter.saveVersion(record.id, {
      version: 1,
      content: { text: 'v1' },
      updatedAt: new Date(),
    });
    await adapter.saveVersion(record.id, {
      version: 2,
      content: { text: 'v2' },
      updatedAt: new Date(),
    });
    const versions = await adapter.getVersions(record.id);
    expect(versions.length).toBe(2);
    expect(versions[0].version).toBe(2);
    expect(versions[1].version).toBe(1);
  });

  test('getVersion returns null for unknown version', async () => {
    const adapter = await initAdapter();
    const record = makeRecord();
    await adapter.createRecord(record);
    expect(await adapter.getVersion(record.id, 99)).toBeNull();
  });

  test('saveVersion is idempotent for same version number', async () => {
    const adapter = await initAdapter();
    const record = makeRecord();
    await adapter.createRecord(record);
    const v = { version: 1, content: { text: 'original' }, updatedAt: new Date() };
    await adapter.saveVersion(record.id, v);
    await adapter.saveVersion(record.id, v); // should not throw or duplicate
    const versions = await adapter.getVersions(record.id);
    expect(versions.length).toBe(1);
  });
});

// -------------------------------------------------------
// Attachments
// -------------------------------------------------------

describe('attachments', () => {
  test('putAttachment returns a fileId', async () => {
    const adapter = await initAdapter();
    const fileId = await adapter.putAttachment(Buffer.from('hello'));
    expect(typeof fileId).toBe('string');
    expect(fileId.length).toBeGreaterThan(0);
  });

  test('putAttachment returns SHA-256 hex string', async () => {
    const adapter = await initAdapter();
    const fileId = await adapter.putAttachment(Buffer.from('hello'));
    expect(fileId).toMatch(/^[0-9a-f]{64}$/);
  });

  test('getAttachment returns the stored data', async () => {
    const adapter = await initAdapter();
    const data = Buffer.from('hello attachment');
    const fileId = await adapter.putAttachment(data);
    const retrieved = await adapter.getAttachment(fileId);
    expect((retrieved as Buffer).toString()).toBe('hello attachment');
  });

  test('attachment file exists on disk without extension', async () => {
    const adapter = await initAdapter();
    const fileId = await adapter.putAttachment(Buffer.from('test'));
    const attachmentsDir = join(testDir, 'attachments');
    const files = readdirSync(attachmentsDir);
    expect(files).toContain(fileId);
  });

  test('getAttachment throws for unknown fileId', async () => {
    const adapter = await initAdapter();
    await expect(adapter.getAttachment('nonexistent')).rejects.toThrow();
  });

  test('putAttachment stores binary data correctly', async () => {
    const adapter = await initAdapter();
    const binary = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // PNG magic bytes
    const fileId = await adapter.putAttachment(binary);
    const retrieved = await adapter.getAttachment(fileId);
    expect(retrieved as Buffer).toEqual(binary);
  });

  test('putAttachment deduplicates identical content', async () => {
    const adapter = await initAdapter();
    const data = Buffer.from('same content');
    const id1 = await adapter.putAttachment(data);
    const id2 = await adapter.putAttachment(data);
    expect(id1).toBe(id2);
    const files = readdirSync(join(testDir, 'attachments'));
    expect(files.filter((f) => f === id1).length).toBe(1);
  });

  test('getAttachment throws after deleteAttachment', async () => {
    const adapter = await initAdapter();
    const fileId = await adapter.putAttachment(Buffer.from('bye'));
    await adapter.deleteAttachment(fileId);
    await expect(adapter.getAttachment(fileId)).rejects.toThrow();
  });

  test('deleteAttachment removes file from disk', async () => {
    const adapter = await initAdapter();
    const fileId = await adapter.putAttachment(Buffer.from('gone'));
    await adapter.deleteAttachment(fileId);
    expect(existsSync(join(testDir, 'attachments', fileId))).toBe(false);
  });
});

// -------------------------------------------------------
// Tokens
// -------------------------------------------------------

describe('tokens', () => {
  test('createToken returns id and plaintext token', async () => {
    const adapter = await initAdapter();
    const { id, token } = await adapter.createToken('entity-abc');
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
    expect(typeof token).toBe('string');
    expect(token.length).toBeGreaterThan(0);
  });

  test('lookupToken returns entityId for valid token', async () => {
    const adapter = await initAdapter();
    const { token } = await adapter.createToken('entity-abc');
    const result = await adapter.lookupToken(token);
    expect(result).not.toBeNull();
    expect(result?.entityId).toBe('entity-abc');
  });

  test('lookupToken returns null for invalid token', async () => {
    const adapter = await initAdapter();
    const result = await adapter.lookupToken('not-a-real-token');
    expect(result).toBeNull();
  });

  test('lookupToken returns null for expired token', async () => {
    const adapter = await initAdapter();
    const { token } = await adapter.createToken('entity-abc', {
      expiresAt: new Date(Date.now() - 1000),
    });
    const result = await adapter.lookupToken(token);
    expect(result).toBeNull();
  });

  test('lookupToken returns entityId for non-expired token', async () => {
    const adapter = await initAdapter();
    const { token } = await adapter.createToken('entity-abc', {
      expiresAt: new Date(Date.now() + 60_000),
    });
    const result = await adapter.lookupToken(token);
    expect(result?.entityId).toBe('entity-abc');
  });

  test('listTokens returns all created tokens', async () => {
    const adapter = await initAdapter();
    await adapter.createToken('entity-a', { label: 'Token A' });
    await adapter.createToken('entity-b', { label: 'Token B' });
    const tokens = await adapter.listTokens();
    expect(tokens.length).toBe(2);
    const labels = tokens.map((t) => t.label);
    expect(labels).toContain('Token A');
    expect(labels).toContain('Token B');
  });

  test('listTokens does not expose plaintext token values', async () => {
    const adapter = await initAdapter();
    await adapter.createToken('entity-abc', { label: 'my-token' });
    const tokens = await adapter.listTokens();
    for (const t of tokens) {
      expect(Object.keys(t)).not.toContain('token');
    }
  });

  test('revokeToken removes the token', async () => {
    const adapter = await initAdapter();
    const { id, token } = await adapter.createToken('entity-abc');
    await adapter.revokeToken(id);
    expect(await adapter.lookupToken(token)).toBeNull();
  });

  test('listTokens returns empty after all tokens revoked', async () => {
    const adapter = await initAdapter();
    const { id } = await adapter.createToken('entity-abc');
    await adapter.revokeToken(id);
    expect(await adapter.listTokens()).toEqual([]);
  });

  test('createToken label is present in listTokens', async () => {
    const adapter = await initAdapter();
    await adapter.createToken('entity-abc', { label: 'my-token' });
    const [t] = await adapter.listTokens();
    expect(t.label).toBe('my-token');
  });

  test('createToken expiresAt is present in listTokens', async () => {
    const adapter = await initAdapter();
    const expiresAt = new Date(Date.now() + 3600_000);
    await adapter.createToken('entity-abc', { expiresAt });
    const [t] = await adapter.listTokens();
    expect(t.expiresAt?.getTime()).toBeCloseTo(expiresAt.getTime(), -2);
  });
});
