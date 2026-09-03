import { describe, test, expect } from 'vitest';
import { combineAdapters } from '../src/combine.js';
import type {
  StackRecordAdapter,
  StackBlobAdapter,
  AdapterCapabilities,
  BlobFileInfo,
  StackRecord,
  FileId,
  TypeId,
} from '../src/types.js';

const purgedRecord: StackRecord = {
  id: 'meta1',
  typeId: '_attachment@1',
  createdAt: new Date('2024-01-01T00:00:00.000Z'),
  updatedAt: new Date('2024-01-01T00:00:00.000Z'),
  content: { fileId: 'file-1' },
  version: 1,
};

// -------------------------------------------------------
// Minimal fakes
// -------------------------------------------------------

const capabilities: AdapterCapabilities = {
  fullTextSearch: false,
  contentFieldQuery: false,
  nestedContentQuery: false,
  sortableFields: ['createdAt', 'updatedAt', 'version'],
  maxAttachmentBytes: null,
  maxContentBytes: null,
};

/** Bare-minimum StackRecordAdapter — only what combineAdapters() touches. */
function makeRecordAdapter(overrides: Partial<StackRecordAdapter> = {}): StackRecordAdapter {
  return {
    capabilities,
    ownerEntityId: 'owner-123',
    timezone: 'UTC',
    createRecord: async (r) => r,
    getRecord: async () => null,
    patchContent: async () => {
      throw new Error('not implemented');
    },
    deleteRecord: async () => null,
    undeleteRecord: async () => {
      throw new Error('not implemented');
    },
    queryRecords: async () => ({ records: [], cursor: null, total: 0 }),
    associate: async () => {
      throw new Error('not implemented');
    },
    dissociate: async () => {
      throw new Error('not implemented');
    },
    setPermissions: async () => {
      throw new Error('not implemented');
    },
    setUnlisted: async () => {
      throw new Error('not implemented');
    },
    getVersions: async () => [],
    getVersion: async () => null,
    saveVersion: async () => {},
    restoreVersion: async () => {
      throw new Error('not implemented');
    },
    commitMigration: async () => {
      throw new Error('not implemented');
    },
    saveType: async () => {},
    getType: async () => null,
    listTypes: async () => [],
    ...overrides,
  };
}

/** Bare-minimum StackBlobAdapter — only what combineAdapters() touches. */
function makeBlobAdapter(overrides: Partial<StackBlobAdapter> = {}): StackBlobAdapter {
  return {
    putAttachment: async () => 'file-id',
    getAttachment: async () => new Uint8Array(),
    deleteAttachment: async () => {},
    ...overrides,
  };
}

describe('combineAdapters', () => {
  test('forwards ownerEntityId, timezone, and capabilities from the record adapter', () => {
    const adapter = combineAdapters({
      record: makeRecordAdapter({ ownerEntityId: 'owner-xyz', timezone: 'Europe/London' }),
      blob: makeBlobAdapter(),
    });
    expect(adapter.ownerEntityId).toBe('owner-xyz');
    expect(adapter.timezone).toBe('Europe/London');
    expect(adapter.capabilities).toBe(capabilities);
  });

  test('forwards basic record and blob operations to their respective parts', async () => {
    let created: unknown;
    let putBytes: unknown;
    const adapter = combineAdapters({
      record: makeRecordAdapter({
        createRecord: async (r) => {
          created = r;
          return r;
        },
      }),
      blob: makeBlobAdapter({
        putAttachment: async (data) => {
          putBytes = data;
          return 'computed-id';
        },
      }),
    });

    const record = {
      id: 'r1',
      typeId: 'note@1' as TypeId,
      createdAt: new Date(),
      updatedAt: new Date(),
      content: {},
      version: 1,
    };
    await adapter.createRecord(record);
    expect(created).toBe(record);

    const bytes = new Uint8Array([1, 2, 3]);
    const fileId = await adapter.putAttachment(bytes);
    expect(putBytes).toBe(bytes);
    expect(fileId).toBe('computed-id');
  });

  test('forwards setUnlisted to the record adapter', async () => {
    let calledWith: [string, boolean] | undefined;
    const adapter = combineAdapters({
      record: makeRecordAdapter({
        setUnlisted: async (id, unlisted) => {
          calledWith = [id, unlisted];
          return { ...purgedRecord, unlistedAt: unlisted ? new Date() : undefined };
        },
      }),
      blob: makeBlobAdapter(),
    });

    await adapter.setUnlisted('r1', true);
    expect(calledWith).toEqual(['r1', true]);
  });

  // putAttachmentWithMetadata promises bytes + record as one atomic
  // operation — something a record backend glued to a blob backend can
  // never honor, so combineAdapters() must not synthesize it. Its absence
  // is what routes Stack.putAttachment() to the bytes-then-create()
  // fallback.
  test('never synthesizes putAttachmentWithMetadata from parts', () => {
    const adapter = combineAdapters({
      record: makeRecordAdapter(),
      blob: makeBlobAdapter(),
    });
    expect('putAttachmentWithMetadata' in adapter).toBe(false);
    expect(adapter.putAttachmentWithMetadata).toBeUndefined();
  });

  // Optional capabilities must round-trip exactly: present when the
  // underlying part implements them, absent otherwise. A wrapper that
  // always defines the key (even forwarding to a missing method) would
  // make Stack.deleteAttachment()/collectAttachmentGarbage() silently
  // "detect" a capability that was never actually implemented.
  describe('optional capability forwarding', () => {
    test('deleteUnreferencedAttachmentRecords is present when the record adapter implements it', async () => {
      let calledWith: [FileId, TypeId] | undefined;
      const adapter = combineAdapters({
        record: makeRecordAdapter({
          deleteUnreferencedAttachmentRecords: async (fileId, metadataTypeId) => {
            calledWith = [fileId, metadataTypeId];
            return [purgedRecord];
          },
        }),
        blob: makeBlobAdapter(),
      });

      expect(adapter.deleteUnreferencedAttachmentRecords).toBeDefined();
      const result = await adapter.deleteUnreferencedAttachmentRecords!('file-1', '_attachment@1');
      expect(result).toEqual([purgedRecord]);
      expect(calledWith).toEqual(['file-1', '_attachment@1']);
    });

    test('deleteUnreferencedAttachmentRecords is absent when the record adapter does not implement it', () => {
      const adapter = combineAdapters({
        record: makeRecordAdapter(),
        blob: makeBlobAdapter(),
      });
      expect(adapter.deleteUnreferencedAttachmentRecords).toBeUndefined();
    });

    test('listFiles is present when the blob adapter implements it', async () => {
      const files: BlobFileInfo[] = [{ fileId: 'f1', size: 3, modifiedAt: new Date() }];
      const adapter = combineAdapters({
        record: makeRecordAdapter(),
        blob: makeBlobAdapter({ listFiles: async () => files }),
      });

      expect(adapter.listFiles).toBeDefined();
      expect(await adapter.listFiles!()).toBe(files);
    });

    test('listFiles is absent when the blob adapter does not implement it', () => {
      const adapter = combineAdapters({
        record: makeRecordAdapter(),
        blob: makeBlobAdapter(),
      });
      expect(adapter.listFiles).toBeUndefined();
    });
  });

  describe('lifecycle', () => {
    test('flush() calls both parts', async () => {
      let recordFlushed = false;
      let blobFlushed = false;
      const adapter = combineAdapters({
        record: makeRecordAdapter({ flush: async () => void (recordFlushed = true) }),
        blob: makeBlobAdapter({ flush: async () => void (blobFlushed = true) }),
      });
      await adapter.flush!();
      expect(recordFlushed).toBe(true);
      expect(blobFlushed).toBe(true);
    });

    test('close() calls both parts', async () => {
      let recordClosed = false;
      let blobClosed = false;
      const adapter = combineAdapters({
        record: makeRecordAdapter({ close: async () => void (recordClosed = true) }),
        blob: makeBlobAdapter({ close: async () => void (blobClosed = true) }),
      });
      await adapter.close!();
      expect(recordClosed).toBe(true);
      expect(blobClosed).toBe(true);
    });

    test('flush() and close() are safe when neither part implements them', async () => {
      const adapter = combineAdapters({ record: makeRecordAdapter(), blob: makeBlobAdapter() });
      await expect(adapter.flush!()).resolves.toBeUndefined();
      await expect(adapter.close!()).resolves.toBeUndefined();
    });
  });
});
