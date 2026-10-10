import { describe, test, expect, beforeEach, vi } from 'vitest';
import { Stack } from '../src/stack.js';
import { MemoryAdapter } from '../src/testing.js';
import { typeHandle } from '../src/type-handle.js';
import {
  StackConflictError,
  StackNotFoundError,
  StackVersionConflictError,
} from '../src/errors.js';
import { StoredVersionError, WRITE_EXPECTATION } from '../src/write-expectation.js';
import type { WriteExpectation } from '../src/write-expectation.js';
import type { ScopedStack } from '../src/scoped-stack.js';
import type { AuthorityAssociation, DataAssociation, RecordId } from '../src/types.js';

const OWNER = 'owner-123';
const MEMBER = 'member-456';

const BookV1 = typeHandle({
  id: 'com.example.reading/book@1',
  name: 'Book',
  schema: { title: { kind: 'string', required: true } },
});

const Book = typeHandle({
  id: 'com.example.reading/book@2',
  name: 'Book',
  migratesFrom: BookV1,
  schema: { title: { kind: 'string', required: true }, pages: { kind: 'number' } },
});

const Shelf = typeHandle({
  id: 'com.example.reading/shelf@1',
  name: 'Shelf',
  schema: { name: { kind: 'string', required: true } },
});

const TAG: DataAssociation = { kind: 'tag', label: 'favourite' };
const SHARE: AuthorityAssociation = {
  kind: 'permission',
  label: 'read',
  grantee: { kind: 'entity', entityId: MEMBER },
};

// The options a collection passes; the verbs' public types never name the key.
const expecting = (expectation: WriteExpectation, rest: object = {}) =>
  ({ ...rest, [WRITE_EXPECTATION]: expectation }) as never;

const BOOK_FAMILY: WriteExpectation = { baseId: Book.baseId, typeId: Book.id };

type Verb = (client: Stack | ScopedStack, id: RecordId, opts?: object) => Promise<unknown>;

// Each verb with arguments that would write had the family matched. A
// call without options passes `undefined`, as an untyped caller would.
const VERBS: Record<string, Verb> = {
  mutate: (c, id, o) => c.mutate(id, { contentPatch: { name: 'Moved' } }, o as never),
  patchContent: (c, id, o) => c.patchContent(id, { name: 'Moved' }, o as never),
  associate: (c, id, o) => c.associate(id, [TAG], o as never),
  dissociate: (c, id, o) => c.dissociate(id, [TAG], o as never),
  amendAssociations: (c, id, o) =>
    c.amendAssociations(id, [{ op: 'add', association: TAG }], o as never),
  grantAccess: (c, id, o) => c.grantAccess(id, [SHARE], o as never),
  revokeAccess: (c, id, o) => c.revokeAccess(id, [SHARE], o as never),
  amendAccess: (c, id, o) => c.amendAccess(id, [{ op: 'add', association: SHARE }], o as never),
  delete: (c, id, o) => c.delete(id, o as never),
  purge: (c, id, o) => c.delete(id, { ...o, purge: true } as never),
  undelete: (c, id, o) => c.undelete(id, o as never),
  restoreVersion: (c, id, o) => c.restoreVersion(id, 1, o as never),
};

let adapter: MemoryAdapter;
let stack: Stack;

beforeEach(async () => {
  adapter = await MemoryAdapter.open({ ownerEntityId: OWNER, timezone: 'UTC' });
  stack = await Stack.open(adapter);
  await stack.defineType(BookV1);
  await stack.defineType(Book);
  await stack.defineType(Shelf);
});

/** A shelf with a version 1 to restore, carrying TAG and SHARE, so every verb has something to move. */
const seedShelf = async (): Promise<RecordId> => {
  const shelf = await stack.create(Shelf.id, { name: 'Kitchen' });
  await stack.patchContent(shelf.id, { name: 'Hall' });
  await stack.associate(shelf.id, [TAG]);
  await stack.grantAccess(shelf.id, [SHARE]);
  return shelf.id;
};

const clients: Record<string, () => Stack | ScopedStack> = {
  Stack: () => stack,
  ScopedStack: () => stack.asEntity(OWNER),
};

describe.each(Object.keys(clients))('a write expectation on %s', (clientName) => {
  const client = () => clients[clientName]!();

  test.each(Object.keys(VERBS))(
    '%s() refuses another family before writing anything',
    async (verb) => {
      const id = await seedShelf();
      if (verb === 'undelete') await stack.delete(id);
      const before = await adapter.getRecord(id);
      const journal = await stack.getJournal(id);

      await expect(VERBS[verb]!(client(), id, expecting(BOOK_FAMILY))).rejects.toThrow(
        StackNotFoundError,
      );

      expect(await adapter.getRecord(id)).toEqual(before);
      expect(await stack.getJournal(id)).toEqual(journal);
    },
  );

  test.each(Object.keys(VERBS))(
    '%s() under an expectation reads the record no more often than without one',
    async (verb) => {
      // A purge on the unscoped Stack reads nothing on its own, so the
      // expectation is the one read it makes.
      if (verb === 'purge' && clientName === 'Stack') return;
      const count = async (opts?: object): Promise<number> => {
        const { id } = await stack.create(Book.id, { title: 'Dune' });
        await stack.patchContent(id, { title: 'Dune Messiah' });
        if (verb === 'dissociate') await stack.associate(id, [TAG]);
        if (verb === 'undelete') await stack.delete(id);
        const spy = vi.spyOn(adapter, 'getRecord');
        await VERBS[verb]!(client(), id, opts).catch(() => {});
        const calls = spy.mock.calls.length;
        spy.mockRestore();
        return calls;
      };
      const plain = await count();
      expect(await count(expecting(BOOK_FAMILY))).toBe(plain);
    },
  );

  test('a content write to a record of an older version carries the stored record', async () => {
    const old = await stack.create(BookV1.id, { title: 'Dune' });

    const err = await client()
      .patchContent(old.id, { pages: 412 }, expecting(BOOK_FAMILY))
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(StoredVersionError);
    expect((err as StoredVersionError).record).toEqual(old);
    expect(await adapter.getRecord(old.id)).toEqual(old);
  });

  test('a deleted record is refused as deleted, whatever version it is stored at', async () => {
    const old = await stack.create(BookV1.id, { title: 'Dune' });
    await stack.delete(old.id);

    const err = await client()
      .patchContent(old.id, { pages: 412 }, expecting(BOOK_FAMILY))
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(StackConflictError);
    expect(err).not.toBeInstanceOf(StoredVersionError);
  });

  test('a stale ifVersion is refused ahead of the stored version', async () => {
    const old = await stack.create(BookV1.id, { title: 'Dune' });
    await stack.patchContent(old.id, { title: 'Dune Messiah' });

    await expect(
      client().patchContent(old.id, { pages: 412 }, expecting(BOOK_FAMILY, { ifVersion: 1 })),
    ).rejects.toThrow(StackVersionConflictError);
  });

  test('a purge under an expectation is pinned to the version it checked', async () => {
    const book = await stack.create(Book.id, { title: 'Dune' });
    const getRecord = adapter.getRecord.bind(adapter);
    vi.spyOn(adapter, 'getRecord').mockImplementationOnce(async (id) => {
      const read = await getRecord(id);
      await stack.patchContent(book.id, { pages: 412 });
      return read;
    });

    await expect(client().delete(book.id, expecting(BOOK_FAMILY, { purge: true }))).rejects.toThrow(
      StackVersionConflictError,
    );
    expect(await adapter.getRecord(book.id)).not.toBeNull();
  });

  test('a purge under an expectation of a missing record purges nothing', async () => {
    if (clientName === 'ScopedStack') return;
    const result = await stack.deleteAndReturn('missing', expecting(BOOK_FAMILY, { purge: true }));
    expect(result).toEqual({ record: null, referencedFileIds: [] });
  });

  test('a write that leaves content alone holds only the family', async () => {
    const old = await stack.create(BookV1.id, { title: 'Dune' });

    const tagged = await client().associate(old.id, [TAG], expecting(BOOK_FAMILY));

    expect(tagged.associations).toEqual([TAG]);
  });

  test('a write within the family goes through', async () => {
    const book = await stack.create(Book.id, { title: 'Dune' });

    const patched = await client().patchContent(book.id, { pages: 412 }, expecting(BOOK_FAMILY));

    expect(patched.content).toEqual({ title: 'Dune', pages: 412 });
  });
});

describe('a write expectation under delegation', () => {
  test('another family is not found, even where the write itself would be refused', async () => {
    const shelf = await stack.create(Shelf.id, { name: 'Kitchen' }, { permissions: [SHARE] });
    const member = stack.asEntity(MEMBER);

    await expect(member.patchContent(shelf.id, { name: 'Hall' })).rejects.toThrow('Cannot update');
    await expect(
      member.patchContent(shelf.id, { name: 'Hall' }, expecting(BOOK_FAMILY)),
    ).rejects.toThrow(StackNotFoundError);
  });
});
