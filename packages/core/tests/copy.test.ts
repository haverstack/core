import { describe, test, expect } from 'vitest';
import { copyStack } from '../src/adapter/copy.js';
import { Stack } from '../src/stack/stack.js';
import { InvalidAdapterError, OwnerMismatchError, StackConflictError } from '../src/errors.js';
import { MemoryAdapter } from '../src/testing.js';
import type { RecordChange, StackAdapter, StoreSeed } from '../src/types/index.js';

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

/**
 * Gives `adapter` a relay, as a hosted source has: each subscription comes
 * up at the next head in `heads` (the last repeating), and `emit()` reports
 * a change to every open one.
 */
function relayed(adapter: MemoryAdapter, heads: (string | undefined)[]) {
  const open = new Set<(change: RecordChange) => void>();
  let connections = 0;
  const change: RecordChange = {
    kind: 'changed',
    ops: ['patch'],
    recordId: 'someone-elses',
    typeId: NOTE,
    version: 2,
    updatedAt: new Date(),
  };
  (adapter as StackAdapter).subscribeChanges = async (opts, handler) => {
    opts.onReady?.(heads[Math.min(connections++, heads.length - 1)]);
    open.add(handler);
    return () => void open.delete(handler);
  };
  return { open, emit: () => open.forEach((handler) => handler(change)) };
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

  test('refuses a source with no listBlobs(), before creating anything', async () => {
    const source = await sourceWith(1);
    source.listBlobs = undefined;
    let created = false;
    await expect(
      copyStack(source, (seed) => {
        created = true;
        return create(seed);
      }),
    ).rejects.toThrow(InvalidAdapterError);
    expect(created).toBe(false);
  });

  // One rule for every way the store create() returns can differ from a new
  // store with the source's identity. See docs/spec/portability.md
  // § Copying a stack.
  describe('refuses a store that is not a new, empty one with the source identity, and closes it', () => {
    type Make = (seed: StoreSeed) => Promise<StackAdapter>;
    const without =
      (method: 'importRecord' | 'listBlobs'): Make =>
      async (seed) => {
        const store = await create(seed);
        Object.defineProperty(store, method, { value: undefined });
        return store;
      };
    const cases: [string, Make, typeof InvalidAdapterError | typeof OwnerMismatchError][] = [
      ['no importRecord()', without('importRecord'), InvalidAdapterError],
      ['no listBlobs()', without('listBlobs'), InvalidAdapterError],
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

  // A source written by others relays those writes; the copy watches the
  // relay and refuses a source that moved. See docs/spec/portability.md
  // § Copying a stack.
  describe('a relayed source', () => {
    test('is copied when it holds still, and the watch is closed after', async () => {
      const source = await sourceWith(3);
      const relay = relayed(source, ['h1']);
      const target = (await copyStack(source, create)) as MemoryAdapter;
      expect([...target.records.keys()].sort()).toEqual([...source.records.keys()].sort());
      expect(relay.open.size).toBe(0);
    });

    test('is refused when a change is relayed during the copy, and the target closed', async () => {
      const source = await sourceWith(3);
      const relay = relayed(source, ['h1']);
      const { made, create: watched } = badStore(async (seed) => {
        relay.emit();
        return create(seed);
      });
      await expect(copyStack(source, watched)).rejects.toThrow(StackConflictError);
      expect(made.closed).toBe(true);
      expect(relay.open.size).toBe(0);
    });

    test('is refused when its head moved, though no frame arrived', async () => {
      const source = await sourceWith(3);
      relayed(source, ['h1', 'h2']);
      await expect(copyStack(source, create)).rejects.toThrow(StackConflictError);
    });

    test('is refused before anything is created when its feed reports no head', async () => {
      const source = await sourceWith(1);
      const relay = relayed(source, [undefined]);
      let created = false;
      await expect(
        copyStack(source, (seed) => {
          created = true;
          return create(seed);
        }),
      ).rejects.toThrow(InvalidAdapterError);
      expect(created).toBe(false);
      expect(relay.open.size).toBe(0);
    });
  });
});
