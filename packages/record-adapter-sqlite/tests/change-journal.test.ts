import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { DatabaseSync } from '../src/node-sqlite.js';
import { NativeSQLiteRecordAdapter } from '../src/index.js';
import { StackNotFoundError } from '@haverstack/core';
import type { StackRecord } from '@haverstack/core';
import type { JournalEntryInput } from '@haverstack/core/adapter';

let testDir: string;
let dbPath: string;

beforeEach(() => {
  testDir = join(tmpdir(), `journal-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(testDir, { recursive: true });
  dbPath = join(testDir, 'test.db');
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

const initAdapter = () =>
  NativeSQLiteRecordAdapter.initialize({
    path: dbPath,
    entityId: 'entity-123',
    timezone: 'UTC',
  });

const makeRecord = (overrides: Partial<StackRecord> = {}): StackRecord => ({
  id: `rec-${Math.random().toString(36).slice(2)}`,
  typeId: 'com.example.test/note@1',
  createdAt: new Date(),
  updatedAt: new Date(),
  content: { text: 'Hello world' },
  version: 1,
  ...overrides,
});

const entry = (over: Partial<JournalEntryInput> = {}): JournalEntryInput => ({
  ops: ['create'],
  kind: 'created',
  ...over,
});

// -------------------------------------------------------
// Append
// -------------------------------------------------------

describe('appendJournal', () => {
  test('stamps the record-derived half off the row the write produced', async () => {
    const adapter = await initAdapter();
    const record = makeRecord({ parentId: undefined });
    await adapter.createRecord(record, { journal: entry() });

    const [logged] = await adapter.getJournal(record.id);
    expect(logged).toMatchObject({
      seq: 1,
      ops: ['create'],
      kind: 'created',
      version: 1,
      typeId: 'com.example.test/note@1',
    });
    expect(logged!.parentId).toBeUndefined();
    expect(logged!.at).toBeInstanceOf(Date);
  });

  test('seq is allocated per record, densely, with no cross-record interleaving', async () => {
    const adapter = await initAdapter();
    const a = makeRecord();
    const b = makeRecord();
    await adapter.createRecord(a, { journal: entry() });
    await adapter.createRecord(b, { journal: entry() });
    await adapter.associate(
      a.id,
      { kind: 'tag', label: 'x' },
      { journal: entry({ ops: ['associate'], kind: 'changed' }) },
    );
    await adapter.associate(
      b.id,
      { kind: 'tag', label: 'y' },
      { journal: entry({ ops: ['associate'], kind: 'changed' }) },
    );

    expect((await adapter.getJournal(a.id)).map((e) => e.seq)).toEqual([1, 2]);
    expect((await adapter.getJournal(b.id)).map((e) => e.seq)).toEqual([1, 2]);
  });

  test('a write passing no journal entry appends nothing', async () => {
    const adapter = await initAdapter();
    const record = makeRecord();
    await adapter.createRecord(record);
    await adapter.associate(record.id, { kind: 'tag', label: 'x' });

    expect(await adapter.getJournal(record.id)).toEqual([]);
  });

  test('previousParentId tells "no origin" apart from "moved off the root"', async () => {
    const adapter = await initAdapter();
    const container = makeRecord();
    const record = makeRecord();
    await adapter.createRecord(container);
    await adapter.createRecord(record, { journal: entry() });

    await adapter.mutateRecord(
      record.id,
      { parentId: container.id },
      { journal: entry({ ops: ['reparent'], kind: 'changed', previousParentId: null }) },
    );
    await adapter.mutateRecord(
      record.id,
      { contentPatch: { text: 'edited' } },
      { journal: entry({ ops: ['patch'], kind: 'changed' }) },
    );

    const log = await adapter.getJournal(record.id);
    expect(log[1]!.previousParentId).toBeNull();
    expect(log[1]!.parentId).toBe(container.id);
    expect('previousParentId' in log[2]!).toBe(false);
  });

  test('association payloads survive the JSON round trip intact', async () => {
    const adapter = await initAdapter();
    const record = makeRecord();
    await adapter.createRecord(record);

    const fileId = 'a'.repeat(64);
    await adapter.associate(
      record.id,
      { kind: 'attachment', label: 'cover', fileId, attachmentRecordId: 'rec-new' },
      {
        journal: entry({
          ops: ['associate'],
          kind: 'changed',
          associations: [
            {
              op: 'repoint',
              association: {
                kind: 'attachment',
                label: 'cover',
                fileId,
                attachmentRecordId: 'rec-new',
              },
              previous: {
                kind: 'attachment',
                label: 'cover',
                fileId,
                attachmentRecordId: 'rec-old',
              },
            },
          ],
        }),
      },
    );

    const [logged] = await adapter.getJournal(record.id);
    expect(logged!.associations).toEqual([
      {
        op: 'repoint',
        association: { kind: 'attachment', label: 'cover', fileId, attachmentRecordId: 'rec-new' },
        previous: { kind: 'attachment', label: 'cover', fileId, attachmentRecordId: 'rec-old' },
      },
    ]);
  });
});

// -------------------------------------------------------
// Atomicity
// -------------------------------------------------------

describe('a journal entry lands in the same write as its mutation', () => {
  test('a failed mutation leaves no entry behind', async () => {
    const adapter = await initAdapter();
    const record = makeRecord();
    await adapter.createRecord(record, { journal: entry() });

    await expect(
      adapter.mutateRecord(
        record.id,
        { contentPatch: { text: 'edited' } },
        {
          ifVersion: 99,
          journal: entry({ ops: ['patch'], kind: 'changed' }),
        },
      ),
    ).rejects.toThrow();

    expect((await adapter.getJournal(record.id)).map((e) => e.seq)).toEqual([1]);
  });
});

// -------------------------------------------------------
// Erasure
// -------------------------------------------------------

describe('a hard delete leaves no journal rows', () => {
  test('the rows go with the record', async () => {
    const adapter = await initAdapter();
    const record = makeRecord();
    await adapter.createRecord(record, { journal: entry() });
    await adapter.associate(
      record.id,
      { kind: 'tag', label: 'sensitive' },
      { journal: entry({ ops: ['associate'], kind: 'changed' }) },
    );

    await adapter.deleteRecord(record.id, { hard: true });
    await adapter.close();

    // Read the table directly: an empty answer through getJournal() would
    // also be what a filtered-but-retained row looks like.
    const db = new DatabaseSync(dbPath);
    const rows = db.prepare('SELECT COUNT(*) as n FROM journal').get() as { n: number };
    db.close();
    expect(rows.n).toBe(0);
  });

  test('the foreign key refuses an entry for a record that is gone', async () => {
    const adapter = await initAdapter();
    const record = makeRecord();
    await adapter.createRecord(record, { journal: entry() });
    await adapter.deleteRecord(record.id, { hard: true });

    await expect(
      adapter.associate(
        record.id,
        { kind: 'tag', label: 'x' },
        { journal: entry({ ops: ['associate'], kind: 'changed' }) },
      ),
    ).rejects.toThrow();
  });
});

// -------------------------------------------------------
// Durability
// -------------------------------------------------------

describe('the log outlives the process that wrote it', () => {
  test('a reopened stack reads back entries written by an earlier one', async () => {
    const adapter = await initAdapter();
    const record = makeRecord();
    await adapter.createRecord(record, { journal: entry() });
    await adapter.associate(
      record.id,
      { kind: 'tag', label: 'draft' },
      {
        journal: entry({
          ops: ['associate'],
          kind: 'changed',
          associations: [{ op: 'add', association: { kind: 'tag', label: 'draft' } }],
        }),
      },
    );
    await adapter.close();

    const reopened = await NativeSQLiteRecordAdapter.open({ path: dbPath });
    const log = await reopened.getJournal(record.id);
    expect(log.map((e) => e.ops.join())).toEqual(['create', 'associate']);
    expect(log[1]!.associations).toEqual([
      { op: 'add', association: { kind: 'tag', label: 'draft' } },
    ]);
    await reopened.close();
  });
});

// -------------------------------------------------------
// Reading
// -------------------------------------------------------

describe('getJournal', () => {
  test('reads oldest first, and windows on sinceSeq and limit', async () => {
    const adapter = await initAdapter();
    const record = makeRecord();
    await adapter.createRecord(record, { journal: entry() });
    for (const label of ['a', 'b', 'c']) {
      await adapter.associate(
        record.id,
        { kind: 'tag', label },
        { journal: entry({ ops: ['associate'], kind: 'changed' }) },
      );
    }

    expect((await adapter.getJournal(record.id)).map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    expect((await adapter.getJournal(record.id, { sinceSeq: 2 })).map((e) => e.seq)).toEqual([
      3, 4,
    ]);
    expect((await adapter.getJournal(record.id, { limit: 2 })).map((e) => e.seq)).toEqual([1, 2]);
    expect(
      (await adapter.getJournal(record.id, { sinceSeq: 1, limit: 2 })).map((e) => e.seq),
    ).toEqual([2, 3]);
  });

  test('a record with no journal reads as an empty log', async () => {
    const adapter = await initAdapter();
    const record = makeRecord();
    await adapter.createRecord(record);
    expect(await adapter.getJournal(record.id)).toEqual([]);
  });

  test('a record that is not there is refused, never answered empty', async () => {
    const adapter = await initAdapter();
    await expect(adapter.getJournal('rec-missing')).rejects.toThrow(StackNotFoundError);
  });
});
