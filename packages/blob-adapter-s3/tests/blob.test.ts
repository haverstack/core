import { describe, test, expect, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import { mockClient } from 'aws-sdk-client-mock';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  NotFound,
  NoSuchKey,
} from '@aws-sdk/client-s3';
import { StackNotFoundError, StackBadRequestError } from '@haverstack/core';
import { S3BlobAdapter } from '../src/index.js';

const BUCKET = 'test-bucket';

// aws-sdk-client-mock stubs one command response at a time; it has no
// notion of server-side state. This fake backs the mocked commands with a
// real in-memory Map so the tests exercise the same read-your-writes
// behavior a real bucket gives the adapter.
class FakeBucket {
  private readonly objects = new Map<string, { body: Uint8Array; modifiedAt: Date }>();

  wire(client: S3Client): void {
    const s3Mock = mockClient(client);

    s3Mock.on(HeadObjectCommand).callsFake(({ Key }) => {
      const obj = this.objects.get(Key!);
      if (!obj) throw new NotFound({ message: 'Not Found', $metadata: {} });
      return {};
    });

    s3Mock.on(PutObjectCommand).callsFake(({ Key, Body }) => {
      this.objects.set(Key!, { body: Body as Uint8Array, modifiedAt: new Date() });
      return {};
    });

    s3Mock.on(GetObjectCommand).callsFake(({ Key }) => {
      const obj = this.objects.get(Key!);
      if (!obj)
        throw new NoSuchKey({ message: 'The specified key does not exist.', $metadata: {} });
      return { Body: { transformToByteArray: async () => obj.body } };
    });

    s3Mock.on(DeleteObjectCommand).callsFake(({ Key }) => {
      this.objects.delete(Key!);
      return {};
    });

    s3Mock.on(ListObjectsV2Command).callsFake(() => ({
      Contents: [...this.objects.entries()].map(([Key, obj]) => ({
        Key,
        Size: obj.body.byteLength,
        LastModified: obj.modifiedAt,
      })),
      IsTruncated: false,
    }));
  }

  has(key: string): boolean {
    return this.objects.has(key);
  }

  size(): number {
    return this.objects.size;
  }

  seed(key: string, body: Uint8Array): void {
    this.objects.set(key, { body, modifiedAt: new Date() });
  }
}

let bucket: FakeBucket;
let adapter: S3BlobAdapter;

beforeEach(() => {
  bucket = new FakeBucket();
  const client = new S3Client({ region: 'us-east-1' });
  bucket.wire(client);
  adapter = new S3BlobAdapter({ bucket: BUCKET, client });
});

describe('S3BlobAdapter', () => {
  test('putBlob returns a fileId', async () => {
    const fileId = await adapter.putBlob(Buffer.from('hello'));
    expect(typeof fileId).toBe('string');
    expect(fileId.length).toBeGreaterThan(0);
  });

  test('putBlob returns SHA-256 hex string', async () => {
    const fileId = await adapter.putBlob(Buffer.from('hello'));
    expect(fileId).toMatch(/^[0-9a-f]{64}$/);
    expect(fileId).toBe(createHash('sha256').update('hello').digest('hex'));
  });

  test('getBlob returns the stored data', async () => {
    const data = Buffer.from('hello attachment');
    const fileId = await adapter.putBlob(data);
    const retrieved = await adapter.getBlob(fileId);
    expect(Buffer.from(retrieved).toString()).toBe('hello attachment');
  });

  test('attachment object exists after put', async () => {
    const fileId = await adapter.putBlob(Buffer.from('test'));
    expect(bucket.has(fileId)).toBe(true);
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
    expect(Buffer.from(retrieved)).toEqual(binary);
  });

  test('putBlob deduplicates identical content', async () => {
    const data = Buffer.from('same content');
    const id1 = await adapter.putBlob(data);
    const id2 = await adapter.putBlob(data);
    expect(id1).toBe(id2);
    expect(bucket.size()).toBe(1);
  });

  test('getBlob throws StackNotFoundError after deleteBlob', async () => {
    const fileId = await adapter.putBlob(Buffer.from('bye'));
    await adapter.deleteBlob(fileId);
    await expect(adapter.getBlob(fileId)).rejects.toThrow(StackNotFoundError);
  });

  test('deleteBlob removes the object', async () => {
    const fileId = await adapter.putBlob(Buffer.from('gone'));
    await adapter.deleteBlob(fileId);
    expect(bucket.has(fileId)).toBe(false);
  });

  test('deleteBlob is non-fatal for missing object', async () => {
    const validHash = 'b'.repeat(64);
    await expect(adapter.deleteBlob(validHash)).resolves.toBeUndefined();
  });

  test('deleteBlob throws StackBadRequestError for invalid fileId format', async () => {
    await expect(adapter.deleteBlob('nonexistent')).rejects.toThrow(StackBadRequestError);
  });

  describe('listBlobs', () => {
    test('returns an empty array for an empty bucket', async () => {
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

    test('ignores non-fileId keys in the bucket', async () => {
      const fileId = await adapter.putBlob(Buffer.from('real blob'));
      // Simulate a stray, non-content-addressed key landing in the bucket.
      bucket.seed('.DS_Store', Buffer.from('stray'));

      const files = await adapter.listBlobs();
      expect(files.map((f) => f.fileId)).toEqual([fileId]);
    });
  });

  describe('constructor', () => {
    test('builds its own client from region/endpoint/forcePathStyle when none is provided', () => {
      expect(
        () =>
          new S3BlobAdapter({
            bucket: BUCKET,
            endpoint: 'https://example.r2.cloudflarestorage.com',
            region: 'auto',
            forcePathStyle: true,
            credentials: { accessKeyId: 'id', secretAccessKey: 'secret' },
          }),
      ).not.toThrow();
    });
  });
});
