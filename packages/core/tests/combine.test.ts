import { describe, test, expect } from 'vitest';
import { combineAdapters } from '../src/adapter/combine.js';
import type {
  StackRecordAdapter,
  StackBlobAdapter,
  StackCapabilities,
  BlobInfo,
  StackRecord,
  FileId,
  TypeId,
  BaseId,
  SubscribeOptions,
  RecordHistory,
} from '../src/types/index.js';

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

const capabilities: StackCapabilities = {
  filter: {
    content: 'none',
    contentPresent: false,
    contentByType: false,
    search: false,
  },
  sort: {
    fields: ['createdAt', 'updatedAt', 'version'],
    contentField: false,
    contentFieldByType: false,
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
    createRecord: async (r) => r,
    getRecord: async () => null,
    patchContent: async () => {
      throw new Error('not implemented');
    },
    setParent: async () => {
      throw new Error('not implemented');
    },
    setUnlisted: async () => {
      throw new Error('not implemented');
    },
    deleteRecord: async () => null,
    undeleteRecord: async () => {
      throw new Error('not implemented');
    },
    queryRecords: async () => ({ records: [], cursor: null }),
    getJournal: async () => [],
    editAssociations: async () => {
      throw new Error('not implemented');
    },
    setAssociations: async () => {
      throw new Error('not implemented');
    },
    editAccess: async () => {
      throw new Error('not implemented');
    },
    setAccess: async () => {
      throw new Error('not implemented');
    },
    getVersions: async () => [],
    getVersion: async () => null,
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
    putBlob: async () => 'file-id',
    getBlob: async () => new Uint8Array(),
    deleteBlob: async () => {},
    ...overrides,
  };
}

describe('combineAdapters', () => {
  test('forwards ownerEntityId and capabilities from the record adapter', () => {
    const adapter = combineAdapters({
      record: makeRecordAdapter({ ownerEntityId: 'owner-xyz' }),
      blob: makeBlobAdapter(),
    });
    expect(adapter.ownerEntityId).toBe('owner-xyz');
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
        putBlob: async (data) => {
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
    const fileId = await adapter.putBlob(bytes);
    expect(putBytes).toBe(bytes);
    expect(fileId).toBe('computed-id');
  });

  test('forwards each aspect write to the record adapter, arguments and options alike', async () => {
    const calls: unknown[][] = [];
    const record =
      (name: string) =>
      async (...args: unknown[]) => {
        calls.push([name, ...args]);
        return purgedRecord;
      };
    const adapter = combineAdapters({
      record: makeRecordAdapter({
        patchContent: record('patchContent'),
        setParent: record('setParent'),
        setUnlisted: record('setUnlisted'),
        editAssociations: record('editAssociations'),
        setAssociations: record('setAssociations'),
        editAccess: record('editAccess'),
        setAccess: record('setAccess'),
      }),
      blob: makeBlobAdapter(),
    });

    const opts = { ifVersion: 3 };
    const tag = { kind: 'tag' as const, label: 'x' };
    const anyone = { kind: 'anyone' as const, label: 'read' as const };
    await adapter.patchContent('r1', { text: 'x' }, opts);
    await adapter.setParent('r1', 'box1', opts);
    await adapter.setUnlisted('r1', true, opts);
    await adapter.editAssociations('r1', [{ op: 'add', association: tag }], opts);
    await adapter.setAssociations('r1', [tag], opts);
    await adapter.editAccess('r1', [{ op: 'add', association: anyone }], opts);
    await adapter.setAccess('r1', [anyone], opts);
    expect(calls).toEqual([
      ['patchContent', 'r1', { text: 'x' }, opts],
      ['setParent', 'r1', 'box1', opts],
      ['setUnlisted', 'r1', true, opts],
      ['editAssociations', 'r1', [{ op: 'add', association: tag }], opts],
      ['setAssociations', 'r1', [tag], opts],
      ['editAccess', 'r1', [{ op: 'add', association: anyone }], opts],
      ['setAccess', 'r1', [anyone], opts],
    ]);
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
        editAssociations: async (_id, _edits, opts) => {
          seen.edit = opts;
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
    await adapter.editAssociations(
      'r1',
      [{ op: 'add', association: { kind: 'tag', label: 'x' } }],
      journal,
    );

    expect(seen.create).toBe(journal);
    expect(seen.edit).toBe(journal);
  });

  describe('optional capability forwarding', () => {
    test('deleteUnreferencedAttachmentRecords is present when the record adapter implements it', async () => {
      let calledWith: [FileId, BaseId] | undefined;
      const adapter = combineAdapters({
        record: makeRecordAdapter({
          deleteUnreferencedAttachmentRecords: async (fileId, metadataBaseId) => {
            calledWith = [fileId, metadataBaseId];
            return [purgedRecord];
          },
        }),
        blob: makeBlobAdapter(),
      });

      expect(adapter.deleteUnreferencedAttachmentRecords).toBeDefined();
      const result = await adapter.deleteUnreferencedAttachmentRecords!('file-1', '_attachment');
      expect(result).toEqual([purgedRecord]);
      expect(calledWith).toEqual(['file-1', '_attachment']);
    });

    test('deleteUnreferencedAttachmentRecords is absent when the record adapter does not implement it', () => {
      const adapter = combineAdapters({
        record: makeRecordAdapter(),
        blob: makeBlobAdapter(),
      });
      expect(adapter.deleteUnreferencedAttachmentRecords).toBeUndefined();
    });

    test('importRecord is present when the record adapter implements it', async () => {
      let calledWith: [StackRecord, RecordHistory] | undefined;
      const adapter = combineAdapters({
        record: makeRecordAdapter({
          importRecord: async (record, history) => {
            calledWith = [record, history];
            return record;
          },
        }),
        blob: makeBlobAdapter(),
      });
      const history: RecordHistory = { versions: [], journal: [] };
      expect(await adapter.importRecord!(purgedRecord, history)).toBe(purgedRecord);
      expect(calledWith).toEqual([purgedRecord, history]);
    });

    test('importRecord is absent when the record adapter does not implement it', () => {
      const adapter = combineAdapters({
        record: makeRecordAdapter(),
        blob: makeBlobAdapter(),
      });
      expect(adapter.importRecord).toBeUndefined();
    });

    test('listBlobs is present when the blob adapter implements it', async () => {
      const files: BlobInfo[] = [{ fileId: 'f1', size: 3, modifiedAt: new Date() }];
      const adapter = combineAdapters({
        record: makeRecordAdapter(),
        blob: makeBlobAdapter({ listBlobs: async () => files }),
      });

      expect(adapter.listBlobs).toBeDefined();
      expect(await adapter.listBlobs!()).toBe(files);
    });

    test('listBlobs is absent when the blob adapter does not implement it', () => {
      const adapter = combineAdapters({
        record: makeRecordAdapter(),
        blob: makeBlobAdapter(),
      });
      expect(adapter.listBlobs).toBeUndefined();
    });

    test('subscribeChanges is present when the record adapter implements it', async () => {
      let received: SubscribeOptions | undefined;
      const stop = () => {};
      const adapter = combineAdapters({
        record: makeRecordAdapter({
          subscribeChanges: async (opts: SubscribeOptions) => {
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
