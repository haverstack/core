import { describe, test, expect } from 'vitest';
import { combineAdapters } from '../src/combine.js';
import type {
  StackRecordAdapter,
  StackBlobAdapter,
  AdapterCapabilities,
  BlobFileInfo,
  StackRecord,
  RecordChangeSet,
  FileId,
  TypeId,
  SubscribeChangesOptions,
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
  filter: {
    content: 'none',
    contentPresent: false,
    search: false,
  },
  sort: {
    fields: ['createdAt', 'updatedAt', 'version'],
    contentField: false,
  },
  limits: {
    attachmentBytes: null,
    contentBytes: null,
  },
};

/** Bare-minimum StackRecordAdapter — only what combineAdapters() touches. */
function makeRecordAdapter(overrides: Partial<StackRecordAdapter> = {}): StackRecordAdapter {
  return {
    capabilities,
    ownerEntityId: 'owner-123',
    timezone: 'UTC',
    createRecord: async (r) => r,
    getRecord: async () => null,
    mutateRecord: async () => {
      throw new Error('not implemented');
    },
    deleteRecord: async () => null,
    undeleteRecord: async () => {
      throw new Error('not implemented');
    },
    queryRecords: async () => ({ records: [], cursor: null }),
    getJournal: async () => [],
    associate: async () => {
      throw new Error('not implemented');
    },
    dissociate: async () => {
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

  test('forwards a change set to the record adapter', async () => {
    let calledWith: [string, RecordChangeSet] | undefined;
    const adapter = combineAdapters({
      record: makeRecordAdapter({
        mutateRecord: async (id, changes) => {
          calledWith = [id, changes];
          return { ...purgedRecord, unlistedAt: changes.unlisted ? new Date() : undefined };
        },
      }),
      blob: makeBlobAdapter(),
    });

    await adapter.mutateRecord('r1', { unlisted: true });
    expect(calledWith).toEqual(['r1', { unlisted: true }]);
  });

  test('forwards every key of a change set, not just the first', async () => {
    let calledWith: [string, RecordChangeSet] | undefined;
    const adapter = combineAdapters({
      record: makeRecordAdapter({
        mutateRecord: async (id, changes) => {
          calledWith = [id, changes];
          return {
            ...purgedRecord,
            ...(changes.parentId != null && { parentId: changes.parentId }),
          };
        },
      }),
      blob: makeBlobAdapter(),
    });

    await adapter.mutateRecord('r1', { parentId: 'box1', contentPatch: { text: 'x' } });
    expect(calledWith).toEqual(['r1', { parentId: 'box1', contentPatch: { text: 'x' } }]);
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
  test('forwards the options every write carries, not just its required arguments', async () => {
    // A wrapper that forwards a method but drops its options turns an
    // atomic write into a silently partial one — a journal entry that is
    // never appended, an actor never stamped.
    const seen: Record<string, unknown> = {};
    const adapter = combineAdapters({
      record: makeRecordAdapter({
        createRecord: async (r, opts) => {
          seen.create = opts;
          return r;
        },
        associate: async (_id, _assoc, opts) => {
          seen.associate = opts;
          return null as never;
        },
        dissociate: async (_id, _assoc, opts) => {
          seen.dissociate = opts;
          return null as never;
        },
      }),
      blob: makeBlobAdapter(),
    });

    const journal = { journal: { ops: ['create' as const], kind: 'created' as const } };
    await adapter.createRecord(
      {
        id: 'r1',
        typeId: 'note@1' as TypeId,
        createdAt: new Date(),
        updatedAt: new Date(),
        content: {},
        version: 1,
      },
      journal,
    );
    await adapter.associate('r1', { kind: 'tag', label: 'x' }, journal);
    await adapter.dissociate('r1', { kind: 'tag', label: 'x' }, journal);

    expect(seen.create).toBe(journal);
    expect(seen.associate).toBe(journal);
    expect(seen.dissociate).toBe(journal);
  });

  describe('optional capability forwarding', () => {
    test('deleteUnreferencedAttachmentRecords is present when the record adapter implements it', async () => {
      let calledWith: [FileId, TypeId[]] | undefined;
      const adapter = combineAdapters({
        record: makeRecordAdapter({
          deleteUnreferencedAttachmentRecords: async (fileId, metadataTypeIds) => {
            calledWith = [fileId, metadataTypeIds];
            return [purgedRecord];
          },
        }),
        blob: makeBlobAdapter(),
      });

      expect(adapter.deleteUnreferencedAttachmentRecords).toBeDefined();
      const result = await adapter.deleteUnreferencedAttachmentRecords!('file-1', [
        '_attachment@1',
        '_attachment@2',
      ]);
      expect(result).toEqual([purgedRecord]);
      expect(calledWith).toEqual(['file-1', ['_attachment@1', '_attachment@2']]);
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

    test('subscribeChanges is present when the record adapter implements it', async () => {
      let received: SubscribeChangesOptions | undefined;
      const stop = () => {};
      const adapter = combineAdapters({
        record: makeRecordAdapter({
          subscribeChanges: async (opts: SubscribeChangesOptions) => {
            received = opts;
            return stop;
          },
        }),
        blob: makeBlobAdapter(),
      });
      expect(await adapter.subscribeChanges!({ since: 'AA3f1Q' }, () => {})).toBe(stop);
      expect(received).toEqual({ since: 'AA3f1Q' });
    });

    test('subscribeChanges is absent when the record adapter does not implement it', () => {
      const adapter = combineAdapters({
        record: makeRecordAdapter(),
        blob: makeBlobAdapter(),
      });
      expect(adapter.subscribeChanges).toBeUndefined();
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
