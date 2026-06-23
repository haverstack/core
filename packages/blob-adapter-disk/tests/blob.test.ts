import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { DiskBlobAdapter } from '../src/index.js';

let testDir: string;
let adapter: DiskBlobAdapter;

beforeEach(() => {
  testDir = join(tmpdir(), `blob-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(testDir, { recursive: true });
  adapter = new DiskBlobAdapter(testDir);
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe('DiskBlobAdapter', () => {
  test('putAttachment returns a fileId', async () => {
    const fileId = await adapter.putAttachment(Buffer.from('hello'));
    expect(typeof fileId).toBe('string');
    expect(fileId.length).toBeGreaterThan(0);
  });

  test('putAttachment returns SHA-256 hex string', async () => {
    const fileId = await adapter.putAttachment(Buffer.from('hello'));
    expect(fileId).toMatch(/^[0-9a-f]{64}$/);
  });

  test('getAttachment returns the stored data', async () => {
    const data = Buffer.from('hello attachment');
    const fileId = await adapter.putAttachment(data);
    const retrieved = await adapter.getAttachment(fileId);
    expect((retrieved as Buffer).toString()).toBe('hello attachment');
  });

  test('attachment file exists on disk', async () => {
    const fileId = await adapter.putAttachment(Buffer.from('test'));
    const files = readdirSync(testDir);
    expect(files).toContain(fileId);
  });

  test('getAttachment throws for unknown fileId', async () => {
    const validHash = 'a'.repeat(64);
    await expect(adapter.getAttachment(validHash)).rejects.toThrow();
  });

  test('getAttachment throws for invalid fileId format', async () => {
    await expect(adapter.getAttachment('nonexistent')).rejects.toThrow(/Invalid fileId/);
  });

  test('putAttachment stores binary data correctly', async () => {
    const binary = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // PNG magic bytes
    const fileId = await adapter.putAttachment(binary);
    const retrieved = await adapter.getAttachment(fileId);
    expect(retrieved as Buffer).toEqual(binary);
  });

  test('putAttachment deduplicates identical content', async () => {
    const data = Buffer.from('same content');
    const id1 = await adapter.putAttachment(data);
    const id2 = await adapter.putAttachment(data);
    expect(id1).toBe(id2);
    const files = readdirSync(testDir);
    expect(files.filter((f) => f === id1).length).toBe(1);
  });

  test('getAttachment throws after deleteAttachment', async () => {
    const fileId = await adapter.putAttachment(Buffer.from('bye'));
    await adapter.deleteAttachment(fileId);
    await expect(adapter.getAttachment(fileId)).rejects.toThrow();
  });

  test('deleteAttachment removes file from disk', async () => {
    const fileId = await adapter.putAttachment(Buffer.from('gone'));
    await adapter.deleteAttachment(fileId);
    expect(existsSync(join(testDir, fileId))).toBe(false);
  });

  test('deleteAttachment is non-fatal for missing file', async () => {
    const validHash = 'b'.repeat(64);
    await expect(adapter.deleteAttachment(validHash)).resolves.toBeUndefined();
  });

  test('constructor creates the directory if it does not exist', () => {
    const newDir = join(testDir, 'nested', 'blobs');
    expect(existsSync(newDir)).toBe(false);
    new DiskBlobAdapter(newDir);
    expect(existsSync(newDir)).toBe(true);
  });
});
