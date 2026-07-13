import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync, readdirSync, writeFileSync } from 'fs';
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

  describe('listFiles', () => {
    test('returns an empty array for an empty store', async () => {
      expect(await adapter.listFiles()).toEqual([]);
    });

    test('lists every stored blob with fileId and size', async () => {
      const id1 = await adapter.putAttachment(Buffer.from('hello'));
      const id2 = await adapter.putAttachment(Buffer.from('a longer blob body'));

      const files = await adapter.listFiles();
      expect(files.map((f) => f.fileId).sort()).toEqual([id1, id2].sort());
      expect(files.find((f) => f.fileId === id1)?.size).toBe(Buffer.from('hello').byteLength);
      expect(files.find((f) => f.fileId === id2)?.size).toBe(
        Buffer.from('a longer blob body').byteLength,
      );
    });

    test('each entry carries a modifiedAt date', async () => {
      const fileId = await adapter.putAttachment(Buffer.from('timestamped'));
      const [file] = await adapter.listFiles();
      expect(file.modifiedAt).toBeInstanceOf(Date);
      expect(file.fileId).toBe(fileId);
    });

    test('deleted blobs no longer appear', async () => {
      const fileId = await adapter.putAttachment(Buffer.from('temporary'));
      await adapter.deleteAttachment(fileId);
      expect(await adapter.listFiles()).toEqual([]);
    });

    test('ignores non-fileId entries in the storage directory', async () => {
      const fileId = await adapter.putAttachment(Buffer.from('real blob'));
      writeFileSync(join(testDir, '.DS_Store'), 'stray file');

      const files = await adapter.listFiles();
      expect(files.map((f) => f.fileId)).toEqual([fileId]);
    });
  });
});
