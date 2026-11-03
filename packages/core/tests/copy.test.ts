import { describe, test, expect } from 'vitest';
import { copyStack } from '../src/adapter/copy.js';
import { Stack } from '../src/stack/stack.js';
import { InvalidAdapterError, OwnerMismatchError, StackConflictError } from '../src/errors.js';
import { MemoryAdapter } from '../src/testing.js';
import type { StackAdapter, StoreSeed } from '../src/types/index.js';

const OWNER = 'did:key:owner';
const NOTE = 'com.example.test/note@1';

const create = (seed: StoreSeed) => MemoryAdapter.open({ seed });

async function sourceWith(notes: number): Promise<MemoryAdapter> {
  const adapter = await MemoryAdapter.open({ ownerEntityId: OWNER });
  const stack = await Stack.open(adapter);
  await stack.defineType({
    id: NOTE,
    name: 'Note',
    schema: { text: { kind: 'text' }, cover: { kind: 'file-ref' } },
  });
  for (let i = 0; i < notes; i++) await stack.create(NOTE, { text: `note ${i}` });
  return adapter;
}

/** A create() whose store fails the target rule in one way, and records whether it was closed. */
function badStore(make: (seed: StoreSeed) => Promise<StackAdapter>) {
  const made: { closed: boolean } = { closed: false };
  return {
    made,
    create: async (seed: StoreSeed) => {
      const store = await make(seed);
      store.close = async () => void (made.closed = true);
      return store;
    },
  };
}

describe('copyStack', () => {
  // _config travels as every Record does, so the target holds what the
  // source's record says now, not what it was created with.
  test('carries _config with its history, a change after open included', async () => {
    const source = await MemoryAdapter.open({ ownerEntityId: OWNER });
    await (
      await Stack.open(source)
    ).editAssociations('_config', [{ op: 'add', association: { kind: 'tag', label: 'moved' } }]);
    const target = await copyStack(source, create);
    expect(target.ownerEntityId).toBe(OWNER);
    expect(await target.getRecord('_config')).toEqual(await source.getRecord('_config'));
    expect(await target.getVersions('_config')).toEqual(await source.getVersions('_config'));
    expect(await target.getJournal('_config')).toEqual(await source.getJournal('_config'));
  });

  test('carries every page of records, not just the first', async () => {
    const source = await sourceWith(250);
    const target = (await copyStack(source, create)) as MemoryAdapter;
    expect([...target.records.keys()].sort()).toEqual([...source.records.keys()].sort());
  });

  test('carries every blob the source lists, named by a Record or not', async () => {
    const source = await sourceWith(0);
    const stack = await Stack.open(source);
    const named = await stack.putAttachment(new Uint8Array([1, 2, 3]), { mimeType: 'image/png' });
    const bare = await source.putBlob(new Uint8Array([9, 9, 9]));
    const target = (await copyStack(source, create)) as MemoryAdapter;
    expect([...target.blobs.keys()].sort()).toEqual([named.content.fileId, bare].sort());
  });

  test('carries every page of blobs, not just the first', async () => {
    const source = await sourceWith(0);
    for (let i = 0; i < 150; i++) await source.putBlob(new Uint8Array([i, 1]));
    const target = (await copyStack(source, create)) as MemoryAdapter;
    expect([...target.blobs.keys()].sort()).toEqual([...source.blobs.keys()].sort());
  });

  test.each(['listBlobs', 'head'] as const)(
    'refuses a source with no %s(), before creating anything',
    async (method) => {
      const source = await sourceWith(1);
      Object.defineProperty(source, method, { value: undefined });
      let created = false;
      await expect(
        copyStack(source, (seed) => {
          created = true;
          return create(seed);
        }),
      ).rejects.toThrow(InvalidAdapterError);
      expect(created).toBe(false);
    },
  );

  // Whoever else writes to the source, the head it reports before and after
  // is the one rule. See docs/spec/portability.md § Copying a stack.
  test('refuses a source written during the copy, and closes the target', async () => {
    const source = await sourceWith(3);
    const { made, create: meanwhile } = badStore(async (seed) => {
      await (await Stack.open(source)).create(NOTE, { text: 'landed mid-copy' });
      return create(seed);
    });
    await expect(copyStack(source, meanwhile)).rejects.toThrow(StackConflictError);
    expect(made.closed).toBe(true);
  });

  test('a Type defined during the copy moves the head too', async () => {
    const source = await sourceWith(1);
    const stack = await Stack.open(source);
    const { create: meanwhile } = badStore(async (seed) => {
      await stack.defineType({ id: 'com.example.test/tag@1', name: 'Tag', schema: {} });
      return create(seed);
    });
    await expect(copyStack(source, meanwhile)).rejects.toThrow(StackConflictError);
  });

  // A write that began before the copy read its first head and lands
  // partway through is still a write during the copy.
  test('refuses a source with a write in flight when the copy began', async () => {
    const source = await sourceWith(1);
    const landing = source.putBlob(new Uint8Array([7, 7]));
    const refused = expect(copyStack(source, create)).rejects.toThrow(StackConflictError);
    await Promise.all([landing, refused]);
  });

  test('a bare blob written during the copy moves the head too', async () => {
    const source = await sourceWith(1);
    const { create: meanwhile } = badStore(async (seed) => {
      await source.putBlob(new Uint8Array([4, 2]));
      return create(seed);
    });
    await expect(copyStack(source, meanwhile)).rejects.toThrow(StackConflictError);
  });

  // One rule for every way the store create() returns can differ from a new
  // store with the source's identity. See docs/spec/portability.md
  // § Copying a stack.
  describe('refuses a store that is not a new, empty one with the source identity, and closes it', () => {
    type Make = (seed: StoreSeed) => Promise<StackAdapter>;
    const without =
      (method: 'importRecord' | 'listBlobs' | 'head'): Make =>
      async (seed) => {
        const store = await create(seed);
        Object.defineProperty(store, method, { value: undefined });
        return store;
      };
    const cases: [string, Make, typeof InvalidAdapterError | typeof OwnerMismatchError][] = [
      ['no importRecord()', without('importRecord'), InvalidAdapterError],
      ['no listBlobs()', without('listBlobs'), InvalidAdapterError],
      ['no head()', without('head'), InvalidAdapterError],
      [
        'another owner',
        async () => MemoryAdapter.open({ ownerEntityId: 'did:key:other' }),
        OwnerMismatchError,
      ],
      ['a Record already in it', async () => sourceWith(1), InvalidAdapterError],
      [
        'the system Types Stack.open() seeds',
        async (seed) => {
          const store = await create(seed);
          await Stack.open(store);
          return store;
        },
        InvalidAdapterError,
      ],
      [
        'a blob already in it',
        async (seed) => {
          const store = await create(seed);
          await store.putBlob(new Uint8Array([5]));
          return store;
        },
        InvalidAdapterError,
      ],
    ];

    test.each(cases)('%s', async (_name, make, error) => {
      const source = await sourceWith(1);
      const { made, create: bad } = badStore(make);
      await expect(copyStack(source, bad)).rejects.toThrow(error);
      expect(made.closed).toBe(true);
    });
  });
});
