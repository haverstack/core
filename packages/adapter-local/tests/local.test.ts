import { describe, test, expect, beforeEach, afterEach } from 'vitest';
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

const initAdapter = (opts?: { timezone?: string; entityId?: string }) =>
  LocalAdapter.initialize({
    path: dbPath,
    entityId: opts?.entityId ?? 'entity-123',
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
    const adapter = await initAdapter({ entityId: 'owner-abc' });
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
    await initAdapter({ entityId: 'owner-abc' });
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
    await initAdapter({ entityId: 'owner-abc', timezone: 'Europe/London' });
    const adapter = await LocalAdapter.open({ path: dbPath });
    expect(adapter.ownerEntityId).toBe('owner-abc');
    expect(adapter.timezone).toBe('Europe/London');
  });
});

// -------------------------------------------------------
// Blob operations through LocalAdapter
// -------------------------------------------------------

describe('attachments', () => {
  test('putAttachment returns a SHA-256 fileId', async () => {
    const adapter = await initAdapter();
    const fileId = await adapter.putAttachment(Buffer.from('hello'));
    expect(fileId).toMatch(/^[0-9a-f]{64}$/);
  });

  test('getAttachment returns stored data', async () => {
    const adapter = await initAdapter();
    const data = Buffer.from('hello attachment');
    const fileId = await adapter.putAttachment(data);
    const retrieved = await adapter.getAttachment(fileId);
    expect((retrieved as Buffer).toString()).toBe('hello attachment');
  });

  test('attachment file is stored in the attachments directory', async () => {
    const adapter = await initAdapter();
    const fileId = await adapter.putAttachment(Buffer.from('test'));
    const attachmentsDir = join(testDir, 'attachments');
    expect(readdirSync(attachmentsDir)).toContain(fileId);
  });

  test('deleteAttachment removes the file', async () => {
    const adapter = await initAdapter();
    const fileId = await adapter.putAttachment(Buffer.from('gone'));
    await adapter.deleteAttachment(fileId);
    await expect(adapter.getAttachment(fileId)).rejects.toThrow();
  });
});

// -------------------------------------------------------
// Token operations through LocalAdapter
// -------------------------------------------------------

describe('tokens', () => {
  test('createToken and lookupToken roundtrip', async () => {
    const adapter = await initAdapter();
    const { token } = await adapter.createToken('entity-abc');
    const result = await adapter.lookupToken(token);
    expect(result?.entityId).toBe('entity-abc');
  });

  test('lookupToken returns null for invalid token', async () => {
    const adapter = await initAdapter();
    expect(await adapter.lookupToken('bogus')).toBeNull();
  });

  test('revokeToken invalidates the token', async () => {
    const adapter = await initAdapter();
    const { id, token } = await adapter.createToken('entity-abc');
    await adapter.revokeToken(id);
    expect(await adapter.lookupToken(token)).toBeNull();
  });

  test('listTokens returns created tokens', async () => {
    const adapter = await initAdapter();
    await adapter.createToken('entity-a', { label: 'Token A' });
    await adapter.createToken('entity-b', { label: 'Token B' });
    const tokens = await adapter.listTokens();
    expect(tokens.length).toBe(2);
  });

  test('tokens live in a separate sibling file, not the main .db', async () => {
    const adapter = await initAdapter();
    expect(existsSync(`${dbPath}.tokens`)).toBe(false);
    await adapter.createToken('entity-abc');
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
  test('deletes an unreferenced metadata record and returns its id', async () => {
    const adapter = await initAdapter();
    await adapter.createRecord(
      makeRecord({
        id: 'meta1',
        typeId: 'com.example.test/_attachment@1',
        content: { fileId: 'file-1' },
      }),
    );

    const deleted = await adapter.deleteUnreferencedAttachmentRecords(
      'file-1',
      'com.example.test/_attachment@1',
    );
    expect(deleted).toEqual(['meta1']);
    expect(await adapter.getRecord('meta1')).toBeNull();
  });
});
