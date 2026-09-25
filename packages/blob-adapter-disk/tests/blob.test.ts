import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync, readdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { StackNotFoundError, StackBadRequestError } from '@haverstack/core';
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
  test('putBlob returns a fileId', async () => {
    const fileId = await adapter.putBlob(Buffer.from('hello'));
    expect(typeof fileId).toBe('string');
    expect(fileId.length).toBeGreaterThan(0);
  });

  test('putBlob returns SHA-256 hex string', async () => {
    const fileId = await adapter.putBlob(Buffer.from('hello'));
    expect(fileId).toMatch(/^[0-9a-f]{64}$/);
  });

  test('getBlob returns the stored data', async () => {
    const data = Buffer.from('hello attachment');
    const fileId = await adapter.putBlob(data);
    const retrieved = await adapter.getBlob(fileId);
    expect((retrieved as Buffer).toString()).toBe('hello attachment');
  });

  test('attachment file exists on disk', async () => {
    const fileId = await adapter.putBlob(Buffer.from('test'));
    const files = readdirSync(testDir);
    expect(files).toContain(fileId);
  });

  test('getBlob throws StackNotFoundError for unknown fileId', async () => {
    const validHash = 'a'.repeat(64);
    await expect(adapter.getBlob(validHash)).rejects.toThrow(StackNotFoundError);
  });

  test('getBlob throws StackBadRequestError for invalid fileId format', async () => {
    await expect(adapter.getBlob('nonexistent')).rejects.toThrow(StackBadRequestError);
    await expect(adapter.getBlob('nonexistent')).rejects.toThrow(/Invalid fileId/);
  });

  test('putBlob stores binary data correctly', async () => {
    const binary = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // PNG magic bytes
    const fileId = await adapter.putBlob(binary);
    const retrieved = await adapter.getBlob(fileId);
    expect(retrieved as Buffer).toEqual(binary);
  });

  test('putBlob deduplicates identical content', async () => {
    const data = Buffer.from('same content');
    const id1 = await adapter.putBlob(data);
    const id2 = await adapter.putBlob(data);
    expect(id1).toBe(id2);
    const files = readdirSync(testDir);
    expect(files.filter((f) => f === id1).length).toBe(1);
  });

  test('putBlob leaves no temp file behind on success', async () => {
    const fileId = await adapter.putBlob(Buffer.from('clean write'));
    const files = readdirSync(testDir);
    expect(files).toEqual([fileId]);
  });

  test('concurrent putBlob of identical content never produces a torn file', async () => {
    const data = Buffer.from('concurrent payload');
    const results = await Promise.all(Array.from({ length: 10 }, () => adapter.putBlob(data)));
    expect(new Set(results).size).toBe(1);

    const [fileId] = results;
    const files = readdirSync(testDir);
    expect(files).toEqual([fileId]);

    const stored = await adapter.getBlob(fileId);
    expect((stored as Buffer).equals(data)).toBe(true);
  });

  test('getBlob throws StackNotFoundError after deleteBlob', async () => {
    const fileId = await adapter.putBlob(Buffer.from('bye'));
    await adapter.deleteBlob(fileId);
    await expect(adapter.getBlob(fileId)).rejects.toThrow(StackNotFoundError);
  });

  test('deleteBlob removes file from disk', async () => {
    const fileId = await adapter.putBlob(Buffer.from('gone'));
    await adapter.deleteBlob(fileId);
    expect(existsSync(join(testDir, fileId))).toBe(false);
  });

  test('deleteBlob is non-fatal for missing file', async () => {
    const validHash = 'b'.repeat(64);
    await expect(adapter.deleteBlob(validHash)).resolves.toBeUndefined();
  });

  test('constructor creates the directory if it does not exist', () => {
    const newDir = join(testDir, 'nested', 'blobs');
    expect(existsSync(newDir)).toBe(false);
    new DiskBlobAdapter(newDir);
    expect(existsSync(newDir)).toBe(true);
  });

  describe('listBlobs', () => {
    test('returns an empty array for an empty store', async () => {
      expect(await adapter.listBlobs()).toEqual([]);
    });

    test('lists every stored blob with fileId and size', async () => {
      const id1 = await adapter.putBlob(Buffer.from('hello'));
      const id2 = await adapter.putBlob(Buffer.from('a longer blob body'));

      const files = await adapter.listBlobs();
      expect(files.map((f) => f.fileId).sort()).toEqual([id1, id2].sort());
      expect(files.find((f) => f.fileId === id1)?.size).toBe(Buffer.from('hello').byteLength);
      expect(files.find((f) => f.fileId === id2)?.size).toBe(
        Buffer.from('a longer blob body').byteLength,
      );
    });

    test('each entry carries a modifiedAt date', async () => {
      const fileId = await adapter.putBlob(Buffer.from('timestamped'));
      const [file] = await adapter.listBlobs();
      expect(file.modifiedAt).toBeInstanceOf(Date);
      expect(file.fileId).toBe(fileId);
    });

    test('deleted blobs no longer appear', async () => {
      const fileId = await adapter.putBlob(Buffer.from('temporary'));
      await adapter.deleteBlob(fileId);
      expect(await adapter.listBlobs()).toEqual([]);
    });

    test('ignores non-fileId entries in the storage directory', async () => {
      const fileId = await adapter.putBlob(Buffer.from('real blob'));
      writeFileSync(join(testDir, '.DS_Store'), 'stray file');

      const files = await adapter.listBlobs();
      expect(files.map((f) => f.fileId)).toEqual([fileId]);
    });
  });
});
