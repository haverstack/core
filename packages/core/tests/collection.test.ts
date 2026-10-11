import { describe, test, expect, expectTypeOf, beforeEach, vi } from 'vitest';
import { Stack } from '../src/stack/stack.js';
import { MemoryAdapter } from '../src/testing.js';
import { migration, typeHandle } from '../src/type-handle.js';
import type { ContentOf, UnlistedValue } from '../src/type-handle.js';
import { MisfitError } from '../src/collection.js';
import type {
  Collection,
  CollectionChange,
  CollectionPage,
  CollectionRecord,
  ContentPatch,
  StoredContent,
} from '../src/collection.js';
import {
  StackBadRequestError,
  StackMigrationError,
  StackNotFoundError,
  StackPermissionError,
  StackVersionConflictError,
} from '../src/errors.js';
import type { StackClient } from '../src/stack/client.js';
import type { AuthorityAssociation, DataAssociation } from '../src/types/index.js';

const OWNER = 'owner-123';
const MEMBER = 'member-456';

// Scoped delivery is asynchronous: the permission check is.
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const BookV1 = typeHandle({
  id: 'com.example.reading/book@1',
  name: 'Book',
  schema: {
    title: { kind: 'string', required: true },
    status: { kind: 'enum', values: ['want', 'reading', 'done'], required: true },
  },
});

const Book = typeHandle({
  id: 'com.example.reading/book@2',
  name: 'Book',
  migratesFrom: BookV1,
  schema: {
    title: { kind: 'string', required: true },
    status: { kind: 'enum', values: ['want', 'reading', 'finished', 'abandoned'], required: true },
    pages: { kind: 'number' },
  },
});

const BookV3 = typeHandle({
  id: 'com.example.reading/book@3',
  name: 'Book',
  migratesFrom: Book,
  schema: { ...Book.schema, isbn: { kind: 'string' } },
});

const Shelf = typeHandle({
  id: 'com.example.reading/shelf@1',
  name: 'Shelf',
  schema: { name: { kind: 'string', required: true } },
});

const bookV1ToV2 = migration(BookV1, Book, (c) => ({
  ...c,
  status: c.status === 'done' ? 'finished' : c.status,
}));

// The naming an app does: an interface keeps its name where a type alias would not.
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
interface BookContent extends ContentOf<typeof Book.schema> {}

const TAG: DataAssociation = { kind: 'tag', label: 'fantasy' };
const share = (label: 'read' | 'write'): AuthorityAssociation => ({
  kind: 'permission',
  label,
  grantee: { kind: 'entity', entityId: MEMBER },
});

describe.each([
  ['Stack', (s: Stack): StackClient => s],
  ['ScopedStack', (s: Stack): StackClient => s.asEntity(OWNER)],
] as const)('a collection on %s', (_name, view) => {
  let adapter: MemoryAdapter;
  let stack: Stack;
  let books: Collection<BookContent>;

  beforeEach(async () => {
    adapter = await MemoryAdapter.open({ ownerEntityId: OWNER, timezone: 'UTC' });
    stack = await Stack.open(adapter, { migrations: [bookV1ToV2] });
    await stack.defineType(BookV1);
    await stack.defineType(Book);
    await stack.defineType(BookV3);
    await stack.defineType(Shelf);
    books = view(stack).collection(Book);
  });

  /** A record stored at `@1`, written past the collection. */
  const createV1 = (title = 'Dune', status = 'done') => stack.create(BookV1.id, { title, status });

  // -------------------------------------------------------
  // Typing
  // -------------------------------------------------------

  test('is typed by content, so an interface naming it is kept', () => {
    expectTypeOf(view(stack).collection(Book)).toEqualTypeOf<
      Collection<ContentOf<typeof Book.schema>>
    >();
    expectTypeOf<
      Awaited<ReturnType<typeof books.get>>
    >().toEqualTypeOf<CollectionRecord<BookContent> | null>();
  });

  test('derives the patch and the stored content from the content type', () => {
    expectTypeOf<ContentPatch<BookContent>>().toEqualTypeOf<{
      title?: string;
      status?: 'want' | 'reading' | 'finished' | 'abandoned';
      pages?: number | null;
    }>();
    expectTypeOf<StoredContent<BookContent>['status']>().toEqualTypeOf<
      'want' | 'reading' | 'finished' | 'abandoned' | UnlistedValue
    >();
  });

  test('create() refuses content outside the schema at compile time', async () => {
    // @ts-expect-error a value outside the enum
    await books.create({ title: 'x', status: 'paused' }).catch(() => undefined);
    // @ts-expect-error a typo'd key
    await books.create({ title: 'x', stauts: 'want' }).catch(() => undefined);
  });

  test('patchContent() refuses a typo, a null on a required field and a bad enum', async () => {
    const book = await books.create({ title: 'Dune', status: 'want' });
    // @ts-expect-error a typo'd key
    await books.patchContent(book.id, { titel: 'x' }).catch(() => undefined);
    // @ts-expect-error null on a required field
    await books.patchContent(book.id, { title: null }).catch(() => undefined);
    // @ts-expect-error a value outside the enum
    await books.patchContent(book.id, { status: 'paused' }).catch(() => undefined);
  });

  test('every verb that returns a record returns it typed', async () => {
    const book = await books.create({ title: 'Dune', status: 'want' });
    expectTypeOf(book).toEqualTypeOf<CollectionRecord<BookContent>>();
    const results = [
      await books.mutate(book.id, { contentPatch: { pages: 412 } }),
      await books.patchContent(book.id, { pages: 413 }),
      await books.associate(book.id, [TAG]),
      await books.dissociate(book.id, [TAG]),
      await books.amendAssociations(book.id, [{ op: 'add', association: TAG }]),
      await books.grantAccess(book.id, [share('read')]),
      await books.revokeAccess(book.id, [share('read')]),
      await books.amendAccess(book.id, [{ op: 'add', association: share('read') }]),
      await books.undelete(book.id),
      await books.restoreVersion(book.id, 1),
    ];
    expectTypeOf(results).toEqualTypeOf<CollectionRecord<BookContent>[]>();
    expect(results.at(-1)?.content).toEqual({ title: 'Dune', status: 'want' });
  });

  // -------------------------------------------------------
  // Reads
  // -------------------------------------------------------

  test('get() round-trips a record', async () => {
    const created = await books.create({ title: 'Dune', status: 'want' });
    expect((await books.get(created.id))?.content).toEqual({ title: 'Dune', status: 'want' });
  });

  test('get() answers null for a missing record, a tombstone and another Type', async () => {
    const book = await books.create({ title: 'Dune', status: 'want' });
    await books.delete(book.id);
    const shelf = await stack.create(Shelf.id, { name: 'Fiction' });
    expect(await books.get('nope')).toBeNull();
    expect(await books.get(book.id)).toBeNull();
    expect(await books.get(shelf.id)).toBeNull();
  });

  test("get() migrates an older record to the handle's version in memory", async () => {
    const old = await createV1();
    const got = await books.get(old.id);
    expect(got?.typeId).toBe(Book.id);
    expect(got?.content).toEqual({ title: 'Dune', status: 'finished' });
    expect(await adapter.getRecord(old.id)).toEqual(old);
  });

  test('get() throws MisfitError for a record newer than the handle', async () => {
    const newer = await stack.create(BookV3.id, { title: 'Dune', status: 'want' });
    const err = await books.get(newer.id).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MisfitError);
    expect((err as MisfitError).reason).toBe('newer-version');
    expect((err as MisfitError).record).toEqual(newer);
  });

  test('get() returns an enum value the handle does not list', async () => {
    const book = await books.create({ title: 'Dune', status: 'want' });
    await stack.defineType({
      id: Book.id,
      name: 'Book',
      schema: { ...Book.schema, status: { kind: 'string', required: true } },
    });
    await stack.patchContent(book.id, { status: 'paused' });
    expect((await books.get(book.id))?.content.status).toBe('paused');
  });

  test('query() returns the family, migrated, and hides tombstones and other Types', async () => {
    const old = await createV1();
    const live = await books.create({ title: 'Emma', status: 'want' });
    const gone = await books.create({ title: 'Ulysses', status: 'want' });
    await books.delete(gone.id);
    await stack.create(Shelf.id, { name: 'Fiction' });

    const page = await books.query({ sort: { field: 'createdAt', direction: 'asc' } });
    expectTypeOf(page).toEqualTypeOf<CollectionPage<BookContent>>();
    expect(page.records.map((r) => [r.id, r.typeId, r.content.status])).toEqual([
      [old.id, Book.id, 'finished'],
      [live.id, Book.id, 'want'],
    ]);
    expect(page.misfits).toEqual([]);
  });

  test('query() reports a newer record as a misfit and keeps the rest of the page', async () => {
    const before = await books.create({ title: 'Dune', status: 'want' });
    const newer = await stack.create(BookV3.id, { title: 'Emma', status: 'want' });
    const after = await books.create({ title: 'Ulysses', status: 'want' });

    const page = await books.query({ sort: { field: 'createdAt', direction: 'asc' } });
    expect(page.records.map((r) => r.id)).toEqual([before.id, after.id]);
    expect(page.misfits).toEqual([{ id: newer.id, reason: 'newer-version', record: newer }]);
  });

  test('query() pages past misfits to every record', async () => {
    const ids = [];
    for (const title of ['a', 'b', 'c', 'd', 'e']) {
      const handle = title === 'b' || title === 'c' ? BookV3.id : Book.id;
      ids.push((await stack.create(handle, { title, status: 'want' })).id);
    }
    const seen: string[] = [];
    let misfits = 0;
    let cursor: string | null | undefined;
    do {
      const page = await books.query({ limit: 2, ...(cursor && { cursor }) });
      seen.push(...page.records.map((r) => r.id), ...page.misfits.map((m) => m.id));
      misfits += page.misfits.length;
      cursor = page.cursor;
    } while (cursor);
    expect(seen.sort()).toEqual([...ids].sort());
    expect(misfits).toBe(2);
  });

  test('query() filters on content', async () => {
    await books.create({ title: 'Dune', status: 'want' });
    await books.create({ title: 'Emma', status: 'reading' });
    const { records } = await books.query({ filter: { content: { status: 'reading' } } });
    expect(records.map((r) => r.content.title)).toEqual(['Emma']);
  });

  test('query() drops typeId and presentAt from an untyped caller', async () => {
    const book = await books.create({ title: 'Dune', status: 'want' });
    const newer = await stack.create(BookV3.id, { title: 'Emma', status: 'want' });
    const page = await books.query({
      presentAt: 'latest',
      filter: { typeId: Shelf.id },
    } as never);
    expect(page.records.map((r) => r.id)).toEqual([book.id]);
    expect(page.misfits.map((m) => m.id)).toEqual([newer.id]);
  });

  test('query() refuses includeDeleted', async () => {
    await expect(
      // @ts-expect-error a collection does not offer includeDeleted
      books.query({ filter: { includeDeleted: true } }),
    ).rejects.toThrow(StackBadRequestError);
  });

  test('a read of an older record with no migration to bridge the gap throws', async () => {
    const reopened = await Stack.open(adapter, {
      migrations: [migration(Book, BookV3, (c) => c)],
    });
    const old = await createV1();
    const v3 = view(reopened).collection(BookV3);
    await expect(v3.get(old.id)).rejects.toThrow(StackMigrationError);
    await expect(v3.query()).rejects.toThrow(StackMigrationError);
  });

  // -------------------------------------------------------
  // Writes
  // -------------------------------------------------------

  test('a write to a record outside the family is not found and writes nothing', async () => {
    const shelf = await stack.create(Shelf.id, { name: 'Fiction' });
    await expect(books.patchContent(shelf.id, { title: 'x' })).rejects.toThrow(StackNotFoundError);
    await expect(books.associate(shelf.id, [TAG])).rejects.toThrow(StackNotFoundError);
    await expect(books.delete(shelf.id)).rejects.toThrow(StackNotFoundError);
    expect(await adapter.getRecord(shelf.id)).toEqual(shelf);
  });

  test('a write reads the record no more often than an untyped one', async () => {
    const book = await books.create({ title: 'Dune', status: 'want' });
    const spy = vi.spyOn(adapter, 'getRecord');
    await view(stack).patchContent(book.id, { title: 'Emma' });
    const untyped = spy.mock.calls.length;
    spy.mockClear();
    await books.patchContent(book.id, { title: 'Dune' });
    expect(spy.mock.calls.length).toBe(untyped);
    spy.mockRestore();
  });

  test('a write to a tombstone is refused as an untyped one is', async () => {
    const book = await books.create({ title: 'Dune', status: 'want' });
    await books.delete(book.id);
    await expect(books.patchContent(book.id, { title: 'x' })).rejects.toThrow(/soft-deleted/);
  });

  test('mutate() carries a typed contentPatch beside the other keys', async () => {
    const book = await books.create({ title: 'Dune', status: 'want' });
    const updated = await books.mutate(book.id, {
      contentPatch: { status: 'finished' },
      unlisted: true,
    });
    expect(updated.content.status).toBe('finished');
    expect(updated.unlistedAt).toBeDefined();
  });

  test('a write that leaves content alone returns an older record migrated, unwritten', async () => {
    const old = await createV1();
    const tagged = await books.associate(old.id, [TAG]);
    expect(tagged.typeId).toBe(Book.id);
    expect(tagged.content).toEqual({ title: 'Dune', status: 'finished' });
    expect((await adapter.getRecord(old.id))?.typeId).toBe(BookV1.id);
  });

  test('a patch to an older record commits the migration first, as its own write', async () => {
    const old = await createV1();
    const patched = await books.patchContent(old.id, { pages: 412 });

    expect(patched.typeId).toBe(Book.id);
    expect(patched.content).toEqual({ title: 'Dune', status: 'finished', pages: 412 });
    expect(patched.version).toBe(3);
    const journal = await stack.getJournal(old.id);
    expect(journal.map((e) => e.ops)).toEqual([['create'], ['migrate'], ['patch']]);
  });

  test('a stale ifVersion fences the migration, and nothing is written', async () => {
    const old = await createV1();
    await stack.patchContent(old.id, { title: 'Dune Messiah' });
    await expect(books.patchContent(old.id, { pages: 412 }, { ifVersion: 1 })).rejects.toThrow(
      StackVersionConflictError,
    );
    expect((await adapter.getRecord(old.id))?.typeId).toBe(BookV1.id);
    expect(await stack.getJournal(old.id)).toHaveLength(2);
  });

  test('a write landing between the migration and the patch fails the patch', async () => {
    const old = await createV1();
    const commit = stack.commitMigration.bind(stack);
    vi.spyOn(stack, 'commitMigration').mockImplementationOnce(async (...args) => {
      const migrated = await commit(...args);
      await stack.patchContent(old.id, { title: 'Dune Messiah' });
      return migrated;
    });
    await expect(books.patchContent(old.id, { pages: 412 })).rejects.toThrow(
      StackVersionConflictError,
    );
    expect((await adapter.getRecord(old.id))?.typeId).toBe(Book.id);
  });

  test('a revert to a pre-migration snapshot can be patched', async () => {
    const old = await createV1();
    await stack.migrateAll(Book.baseId);
    const reverted = await books.restoreVersion(old.id, 1);
    expect(reverted.typeId).toBe(Book.id);
    expect(reverted.content).toEqual({ title: 'Dune', status: 'finished' });
    expect((await adapter.getRecord(old.id))?.typeId).toBe(BookV1.id);

    const patched = await books.patchContent(old.id, { pages: 412 });
    expect(patched.content).toEqual({ title: 'Dune', status: 'finished', pages: 412 });
    expect((await stack.getJournal(old.id)).map((e) => e.ops[0])).toEqual([
      'create',
      'migrate',
      'restore',
      'migrate',
      'patch',
    ]);
  });

  test('a content write to a newer record throws MisfitError before writing', async () => {
    const newer = await stack.create(BookV3.id, { title: 'Dune', status: 'want' });
    const err = await books.patchContent(newer.id, { pages: 412 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MisfitError);
    expect(await adapter.getRecord(newer.id)).toEqual(newer);
  });

  test('a write that leaves a newer record lands, then throws MisfitError', async () => {
    const newer = await stack.create(BookV3.id, { title: 'Dune', status: 'want' });
    const err = await books.associate(newer.id, [TAG]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MisfitError);
    expect((err as MisfitError).record.associations).toEqual([TAG]);
    expect((err as Error).message).toMatch(/the write landed/);
  });

  // -------------------------------------------------------
  // Subscriptions
  // -------------------------------------------------------

  test('subscribe() covers the family, migrating older records and reporting misfits', async () => {
    const seen: CollectionChange<BookContent>[] = [];
    const stop = await books.subscribe((change) => seen.push(change), { includeRecords: true });
    await stack.create(Shelf.id, { name: 'Fiction' });
    const old = await createV1();
    const book = await books.create({ title: 'Emma', status: 'want' });
    const newer = await stack.create(BookV3.id, { title: 'Ulysses', status: 'want' });
    await settle();
    stop();

    expect(seen.map((c) => c.recordId)).toEqual([old.id, book.id, newer.id]);
    expect(seen[0].typeId).toBe(BookV1.id);
    expect(seen[0].record?.typeId).toBe(Book.id);
    expect(seen[0].record?.content).toEqual({ title: 'Dune', status: 'finished' });
    expect(seen[1].record?.content).toEqual({ title: 'Emma', status: 'want' });
    expect(seen[2].record).toBeUndefined();
    expect(seen[2].misfit).toEqual({ id: newer.id, reason: 'newer-version', record: newer });
  });

  test('subscribe() never types a tombstone', async () => {
    const book = await books.create({ title: 'Dune', status: 'want' });
    const seen: CollectionChange<BookContent>[] = [];
    const stop = await books.subscribe((change) => seen.push(change), { includeRecords: true });
    await books.delete(book.id);
    await settle();
    stop();

    expect(seen.map((c) => c.kind)).toEqual(['removed']);
    expect(seen[0].record).toBeUndefined();
    expect(seen[0].misfit).toBeUndefined();
  });

  test('subscribe() takes the rest of the change filter', async () => {
    const seen: string[] = [];
    const stop = await books.subscribe((c) => seen.push(c.kind), {
      filter: { kinds: ['removed'] },
    });
    const book = await books.create({ title: 'Dune', status: 'want' });
    await books.delete(book.id);
    await settle();
    stop();
    expect(seen).toEqual(['removed']);
  });
});

describe.each([
  ['Stack', (s: Stack): StackClient => s],
  ['ScopedStack', (s: Stack): StackClient => s.asEntity(OWNER)],
] as const)('a collection whose records migrate out of the family, on %s', (_name, view) => {
  let stack: Stack;

  beforeEach(async () => {
    const adapter = await MemoryAdapter.open({ ownerEntityId: OWNER, timezone: 'UTC' });
    stack = await Stack.open(adapter, {
      migrations: [bookV1ToV2, migration(Shelf, Book, (c) => ({ title: c.name, status: 'want' }))],
    });
    await stack.defineType(BookV1);
    await stack.defineType(Book);
    await stack.defineType(Shelf);
  });

  test('subscribe() delivers the change that moves a record out without its record', async () => {
    const shelves = view(stack).collection(Shelf);
    const seen: CollectionChange<ContentOf<typeof Shelf.schema>>[] = [];
    const stop = await shelves.subscribe((change) => seen.push(change), { includeRecords: true });
    const shelf = await shelves.create({ name: 'Fiction' });
    await stack.migrateAll(Shelf.baseId);
    await settle();
    stop();

    expect(seen.map((c) => [c.recordId, c.ops])).toEqual([
      [shelf.id, ['create']],
      [shelf.id, ['migrate']],
    ]);
    expect(seen[1].record).toBeUndefined();
    expect(seen[1].misfit).toBeUndefined();
  });

  test('restoreVersion() refuses a snapshot from another family and writes nothing', async () => {
    const shelf = await stack.create(Shelf.id, { name: 'Fiction' });
    await stack.migrateAll(Shelf.baseId);
    const before = await stack.get(shelf.id);
    const books = view(stack).collection(Book);

    await expect(books.restoreVersion(shelf.id, 1)).rejects.toThrow(
      `Version 1 not found for record "${shelf.id}"`,
    );
    expect(await stack.get(shelf.id)).toEqual(before);
  });
});

describe('a collection whose migration function throws', () => {
  test('subscribe() still delivers the change, without its record', async () => {
    const stack = await Stack.open(
      await MemoryAdapter.open({ ownerEntityId: OWNER, timezone: 'UTC' }),
      {
        migrations: [
          migration(BookV1, Book, () => {
            throw new TypeError('broken migration');
          }),
        ],
      },
    );
    await stack.defineType(BookV1);
    await stack.defineType(Book);
    const books = stack.collection(Book);
    const seen: CollectionChange<BookContent>[] = [];
    const stop = await books.subscribe((change) => seen.push(change), { includeRecords: true });
    const old = await stack.create(BookV1.id, { title: 'Dune', status: 'want' });
    stop();

    expect(seen.map((c) => c.recordId)).toEqual([old.id]);
    expect(seen[0].record).toBeUndefined();
    await expect(books.get(old.id)).rejects.toThrow('broken migration');
  });
});

describe('collection()', () => {
  test('refuses a handle whose migratesFrom has no migration', async () => {
    const stack = await Stack.open(
      await MemoryAdapter.open({ ownerEntityId: OWNER, timezone: 'UTC' }),
    );
    expect(() => stack.collection(Book)).toThrow(
      `No migration from "${BookV1.id}" to "${Book.id}" was passed to Stack.open().`,
    );
    expect(() => stack.asEntity(OWNER).collection(Book)).toThrow(StackMigrationError);
    expect(stack.collection(BookV1)).toBeDefined();
  });
});

describe('a collection under delegation', () => {
  test('refuses a patch needing a migration the requester may not commit', async () => {
    const stack = await Stack.open(
      await MemoryAdapter.open({ ownerEntityId: OWNER, timezone: 'UTC' }),
      { migrations: [bookV1ToV2] },
    );
    await stack.defineType(BookV1);
    await stack.defineType(Book);
    const old = await stack.create(
      BookV1.id,
      { title: 'Dune', status: 'want' },
      { permissions: [share('read'), share('write')] },
    );
    const books = stack.asEntity(MEMBER).collection(Book);

    await expect(books.patchContent(old.id, { pages: 412 })).rejects.toThrow(StackPermissionError);
    await expect(books.patchContent(old.id, { pages: 412 })).rejects.toThrow(
      `stored at ${BookV1.id}`,
    );
    expect(await stack.get(old.id)).toEqual(old);

    await stack.migrateAll(Book.baseId);
    expect((await books.patchContent(old.id, { pages: 412 })).content.pages).toBe(412);
  });
});
