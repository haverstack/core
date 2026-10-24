import { describe, test, expect } from 'vitest';
import { copyStack } from '../src/adapter/copy.js';
import type { StackIdentity } from '../src/adapter/copy.js';
import { Stack } from '../src/stack/stack.js';
import { InvalidAdapterError } from '../src/errors.js';
import { MemoryAdapter } from '../src/testing.js';
import type { StackAdapter } from '../src/types/index.js';

const OWNER = 'did:key:owner';
const NOTE = 'com.example.test/note@1';

const create = ({ ownerEntityId, timezone }: StackIdentity) =>
  MemoryAdapter.open({ ownerEntityId, timezone });

async function sourceWith(notes: number): Promise<MemoryAdapter> {
  const adapter = await MemoryAdapter.open({ ownerEntityId: OWNER, timezone: 'UTC' });
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
function badStore(make: () => Promise<StackAdapter>) {
  const made: { closed: boolean } = { closed: false };
  return {
    made,
    create: async () => {
      const store = await make();
      store.close = async () => void (made.closed = true);
      return store;
    },
  };
}

describe('copyStack', () => {
  test('creates the target with the source identity, timezone included', async () => {
    const source = await MemoryAdapter.open({ ownerEntityId: OWNER, timezone: 'Europe/Paris' });
    const target = await copyStack(source, create);
    expect([target.ownerEntityId, target.timezone]).toEqual([OWNER, 'Europe/Paris']);
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

  test('carries every blob a Record names, by any of the three ways, with no listing to go on', async () => {
    const source = await sourceWith(0);
    source.listBlobs = undefined;
    const stack = await Stack.open(source);
    const meta = await stack.putAttachment(new Uint8Array([1]), { mimeType: 'image/png' });
    const viaField = await source.putBlob(new Uint8Array([2]));
    const viaAssociation = await source.putBlob(new Uint8Array([3]));
    const unnamed = await source.putBlob(new Uint8Array([4]));
    await stack.create(NOTE, { text: 'cover', cover: viaField });
    const tagged = await stack.create(NOTE, { text: 'attached' });
    await stack.editAssociations(tagged.id, [
      { op: 'add', association: { kind: 'attachment', label: 'file', fileId: viaAssociation } },
    ]);

    const target = (await copyStack(source, create)) as MemoryAdapter;
    expect([...target.blobs.keys()].sort()).toEqual(
      [meta.content.fileId, viaField, viaAssociation].sort(),
    );
    expect(target.blobs.has(unnamed)).toBe(false);
  });

  test('a reference whose bytes are gone copies as it stands, dangling', async () => {
    const source = await sourceWith(0);
    source.listBlobs = undefined;
    const gone = await source.putBlob(new Uint8Array([7]));
    await (await Stack.open(source)).create(NOTE, { text: 'cover', cover: gone });
    await source.deleteBlob(gone);
    const target = (await copyStack(source, create)) as MemoryAdapter;
    expect(target.blobs.size).toBe(0);
    expect(target.records.size).toBe(source.records.size);
  });

  // One rule for every way the store create() returns can differ from a new
  // store with the source's identity. See docs/spec/portability.md
  // § Copying a stack.
  describe('refuses a store that is not a new, empty one with the source identity, and closes it', () => {
    const cases: [string, (identity: StackIdentity) => Promise<StackAdapter>][] = [
      [
        'no importRecord()',
        async (identity) => {
          const store = await create(identity);
          Object.defineProperty(store, 'importRecord', { value: undefined });
          return store;
        },
      ],
      [
        'another owner',
        async ({ timezone }) => create({ ownerEntityId: 'did:key:other', timezone }),
      ],
      [
        'another timezone',
        async ({ ownerEntityId }) => create({ ownerEntityId, timezone: 'Asia/Tokyo' }),
      ],
      ['a Record already in it', async () => sourceWith(1)],
      [
        'the system Types Stack.open() seeds',
        async (identity) => {
          const store = await create(identity);
          await Stack.open(store);
          return store;
        },
      ],
      [
        'a Type of its own',
        async (identity) => {
          const store = await create(identity);
          await (
            await Stack.open(store)
          ).defineType({ id: 'com.example.other/x@1', name: 'X', schema: {} });
          return store;
        },
      ],
    ];

    test.each(cases)('%s', async (_name, make) => {
      const source = await sourceWith(1);
      const identity = { ownerEntityId: OWNER, timezone: 'UTC' };
      const { made, create: bad } = badStore(() => make(identity));
      await expect(copyStack(source, bad)).rejects.toThrow(InvalidAdapterError);
      expect(made.closed).toBe(true);
    });
  });
});
