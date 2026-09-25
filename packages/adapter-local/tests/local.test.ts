import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { LocalAdapter } from '../src/index.js';
import type { StackRecord } from '@haverstack/core';

let testDir: string;
let dbPath: string;

beforeEach(() => {
  testDir = join(tmpdir(), `local-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(testDir, { recursive: true });
  dbPath = join(testDir, 'test.db');
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

const initAdapter = (opts?: { timezone?: string; ownerEntityId?: string }) =>
  LocalAdapter.initialize({
    path: dbPath,
    ownerEntityId: opts?.ownerEntityId ?? 'entity-123',
    timezone: opts?.timezone ?? 'America/New_York',
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

// -------------------------------------------------------
// initialize / open
// -------------------------------------------------------

describe('initialize', () => {
  test('creates a new database file', async () => {
    await initAdapter();
    expect(existsSync(dbPath)).toBe(true);
  });

  test('creates an attachments directory next to the database', async () => {
    await initAdapter();
    expect(existsSync(join(testDir, 'attachments'))).toBe(true);
  });

  test('exposes ownerEntityId', async () => {
    const adapter = await initAdapter({ ownerEntityId: 'owner-abc' });
    expect(adapter.ownerEntityId).toBe('owner-abc');
  });

  test('exposes timezone', async () => {
    const adapter = await initAdapter({ timezone: 'Europe/London' });
    expect(adapter.timezone).toBe('Europe/London');
  });

  test('throws if database already exists', async () => {
    await initAdapter();
    await expect(initAdapter()).rejects.toThrow(/already exists/);
  });
});

describe('open', () => {
  test('opens an existing stack', async () => {
    await initAdapter({ ownerEntityId: 'owner-abc' });
    const adapter = await LocalAdapter.open({ path: dbPath });
    expect(adapter.ownerEntityId).toBe('owner-abc');
  });

  test('throws if database does not exist', async () => {
    await expect(LocalAdapter.open({ path: join(testDir, 'nonexistent.db') })).rejects.toThrow(
      /no database found/,
    );
  });

  test('data persists across adapter instances', async () => {
    const adapter1 = await initAdapter();
    const record = makeRecord({ id: 'persist-test' });
    await adapter1.createRecord(record);

    const adapter2 = await LocalAdapter.open({ path: dbPath });
    expect(await adapter2.getRecord('persist-test')).not.toBeNull();
  });

  test('preserves ownerEntityId and timezone across reopen', async () => {
    await initAdapter({ ownerEntityId: 'owner-abc', timezone: 'Europe/London' });
    const adapter = await LocalAdapter.open({ path: dbPath });
    expect(adapter.ownerEntityId).toBe('owner-abc');
    expect(adapter.timezone).toBe('Europe/London');
  });
});

describe('openOrInitialize', () => {
  test('initializes a new database when none exists', async () => {
    const adapter = await LocalAdapter.openOrInitialize({
      path: dbPath,
      ownerEntityId: 'owner-abc',
    });
    expect(existsSync(dbPath)).toBe(true);
    expect(adapter.ownerEntityId).toBe('owner-abc');
  });

  test('opens an existing database instead of re-initializing', async () => {
    await initAdapter({ ownerEntityId: 'owner-abc' });
    const record = makeRecord({ id: 'existing' });
    await (await LocalAdapter.open({ path: dbPath })).createRecord(record);

    const adapter = await LocalAdapter.openOrInitialize({
      path: dbPath,
      ownerEntityId: 'owner-abc',
    });
    expect(adapter.ownerEntityId).toBe('owner-abc');
    expect(await adapter.getRecord('existing')).not.toBeNull();
  });

  test('does not invoke a lazy ownerEntityId provider on the open path', async () => {
    await initAdapter({ ownerEntityId: 'owner-abc' });
    const provider = vi.fn(() => 'should-not-be-called');

    const adapter = await LocalAdapter.openOrInitialize({ path: dbPath, ownerEntityId: provider });

    expect(adapter.ownerEntityId).toBe('owner-abc');
    expect(provider).not.toHaveBeenCalled();
  });

  test('invokes a lazy ownerEntityId provider on the initialize path, sync or async', async () => {
    const adapter = await LocalAdapter.openOrInitialize({
      path: dbPath,
      ownerEntityId: async () => 'generated-owner',
    });
    expect(adapter.ownerEntityId).toBe('generated-owner');
  });

  test('throws if a plain-string ownerEntityId does not match the existing owner', async () => {
    await initAdapter({ ownerEntityId: 'owner-abc' });
    await expect(
      LocalAdapter.openOrInitialize({ path: dbPath, ownerEntityId: 'owner-xyz' }),
    ).rejects.toThrow(/owned by "owner-abc"/);
  });

  test('passes timezone through on the initialize path only', async () => {
    const adapter = await LocalAdapter.openOrInitialize({
      path: dbPath,
      ownerEntityId: 'owner-abc',
      timezone: 'Europe/London',
    });
    expect(adapter.timezone).toBe('Europe/London');
  });
});

// -------------------------------------------------------
// Blob operations through LocalAdapter
// -------------------------------------------------------

describe('attachments', () => {
  test('putBlob returns a SHA-256 fileId', async () => {
    const adapter = await initAdapter();
    const fileId = await adapter.putBlob(Buffer.from('hello'));
    expect(fileId).toMatch(/^[0-9a-f]{64}$/);
  });

  test('getBlob returns stored data', async () => {
    const adapter = await initAdapter();
    const data = Buffer.from('hello attachment');
    const fileId = await adapter.putBlob(data);
    const retrieved = await adapter.getBlob(fileId);
    expect((retrieved as Buffer).toString()).toBe('hello attachment');
  });

  test('attachment file is stored in the attachments directory', async () => {
    const adapter = await initAdapter();
    const fileId = await adapter.putBlob(Buffer.from('test'));
    const attachmentsDir = join(testDir, 'attachments');
    expect(readdirSync(attachmentsDir)).toContain(fileId);
  });

  test('deleteBlob removes the file', async () => {
    const adapter = await initAdapter();
    const fileId = await adapter.putBlob(Buffer.from('gone'));
    await adapter.deleteBlob(fileId);
    await expect(adapter.getBlob(fileId)).rejects.toThrow();
  });

  test('listBlobs reports stored blobs with size and modifiedAt', async () => {
    const adapter = await initAdapter();
    const fileId = await adapter.putBlob(Buffer.from('hello attachment'));

    const files = await adapter.listBlobs();

    expect(files).toHaveLength(1);
    expect(files[0].fileId).toBe(fileId);
    expect(files[0].size).toBe(Buffer.from('hello attachment').byteLength);
    expect(files[0].modifiedAt).toBeInstanceOf(Date);
  });
});

// -------------------------------------------------------
// Token operations through LocalAdapter
// -------------------------------------------------------

describe('tokens', () => {
  test('createToken and lookupToken roundtrip', async () => {
    const adapter = await initAdapter();
    const { token } = await adapter.createToken({ subjectId: 'entity-abc' });
    const result = await adapter.lookupToken(token);
    expect(result).toEqual({ principalId: 'entity-abc', subjectId: 'entity-abc' });
  });

  test('lookupToken returns null for invalid token', async () => {
    const adapter = await initAdapter();
    expect(await adapter.lookupToken('bogus')).toBeNull();
  });

  test('revokeToken invalidates the token', async () => {
    const adapter = await initAdapter();
    const { id, token } = await adapter.createToken({ subjectId: 'entity-abc' });
    await adapter.revokeToken(id);
    expect(await adapter.lookupToken(token)).toBeNull();
  });

  test('listTokens returns created tokens', async () => {
    const adapter = await initAdapter();
    await adapter.createToken({ subjectId: 'entity-a' }, { label: 'Token A' });
    await adapter.createToken({ subjectId: 'entity-b' }, { label: 'Token B' });
    const tokens = await adapter.listTokens();
    expect(tokens.length).toBe(2);
  });

  test('tokens live in a separate sibling file, not the main .db', async () => {
    const adapter = await initAdapter();
    expect(existsSync(`${dbPath}.tokens`)).toBe(false);
    await adapter.createToken({ subjectId: 'entity-abc' });
    expect(existsSync(`${dbPath}.tokens`)).toBe(true);
  });

  test('never touching tokens never creates the sibling token store file', async () => {
    const adapter = await initAdapter();
    await adapter.createRecord(makeRecord());
    await adapter.close();
    expect(existsSync(`${dbPath}.tokens`)).toBe(false);
  });
});

// -------------------------------------------------------
// deleteUnreferencedAttachmentRecords through LocalAdapter
// -------------------------------------------------------

describe('deleteUnreferencedAttachmentRecords', () => {
  test('deletes an unreferenced metadata record and returns it', async () => {
    const adapter = await initAdapter();
    await adapter.createRecord(
      makeRecord({
        id: 'meta1',
        typeId: 'com.example.test/_attachment@1',
        content: { fileId: 'file-1' },
      }),
    );

    const deleted = await adapter.deleteUnreferencedAttachmentRecords('file-1', [
      'com.example.test/_attachment@1',
    ]);
    expect(deleted.map((r) => r.id)).toEqual(['meta1']);
    expect(await adapter.getRecord('meta1')).toBeNull();
  });
});

// -------------------------------------------------------
// Journal delegation
// -------------------------------------------------------

describe('journal', () => {
  test('records the entry a create carries', async () => {
    const adapter = await initAdapter();
    const record = await adapter.createRecord(makeRecord({ id: 'rec1' }), {
      journal: { kind: 'created', ops: ['create'], actor: { subjectId: 'entity-123' } },
    });

    const entries = await adapter.getJournal(record.id);
    expect(entries.map((e) => ({ seq: e.seq, ops: e.ops }))).toEqual([{ seq: 1, ops: ['create'] }]);
    expect(entries[0]!.actor).toEqual({ subjectId: 'entity-123' });
  });

  test('records the entry an associate carries, with what it displaced', async () => {
    const adapter = await initAdapter();
    await adapter.createRecord(makeRecord({ id: 'rec1' }));
    const association = { kind: 'attachment', label: 'embed', fileId: 'file-1' } as const;

    await adapter.associate(
      'rec1',
      { ...association, attachmentRecordId: 'meta1' },
      {
        journal: {
          kind: 'changed',
          ops: ['associate'],
          associations: [
            { op: 'add', association: { ...association, attachmentRecordId: 'meta1' } },
          ],
        },
      },
    );
    await adapter.associate(
      'rec1',
      { ...association, attachmentRecordId: 'meta2' },
      {
        journal: {
          kind: 'changed',
          ops: ['associate'],
          associations: [
            {
              op: 'repoint',
              association: { ...association, attachmentRecordId: 'meta2' },
              previous: { ...association, attachmentRecordId: 'meta1' },
            },
          ],
        },
      },
    );

    const entries = await adapter.getJournal('rec1');
    expect(entries.map((e) => e.seq)).toEqual([1, 2]);
    // The re-point's `previous` is the only surviving record of the
    // attachmentRecordId the second associate overwrote.
    expect(entries[1]!.associations).toEqual([
      {
        op: 'repoint',
        association: { ...association, attachmentRecordId: 'meta2' },
        previous: { ...association, attachmentRecordId: 'meta1' },
      },
    ]);
  });

  test('records the entry a dissociate carries', async () => {
    const adapter = await initAdapter();
    await adapter.createRecord(makeRecord({ id: 'rec1' }));
    const association = { kind: 'tag', label: 'draft' } as const;
    await adapter.associate('rec1', association);
    await adapter.dissociate('rec1', association, {
      journal: {
        kind: 'changed',
        ops: ['dissociate'],
        associations: [{ op: 'remove', previous: association }],
      },
    });

    const entries = await adapter.getJournal('rec1');
    expect(entries.map((e) => e.ops)).toEqual([['dissociate']]);
    expect(entries[0]!.associations).toEqual([{ op: 'remove', previous: association }]);
  });
});
