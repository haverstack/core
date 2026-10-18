import { describe, test, expect, expectTypeOf, beforeEach, vi } from 'vitest';
import { Stack } from '../src/stack/stack.js';
import { MemoryAdapter } from '../src/testing.js';
import { migration, typeHandle } from '../src/type-handle.js';
import { add, derive, drop, map, rename } from '../src/migration-steps.js';
import type { ContentOf, ReadonlyTypeSchema, UnlistedValue } from '../src/type-handle.js';
import { MisfitError } from '../src/collection.js';
import type {
  Collection,
  CollectionChange,
  CollectionPage,
  CollectionQuery,
  CollectionRecord,
  ContentPatch,
  ContentPathOf,
  SortableFieldOf,
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

const bookV1ToV2 = migration(BookV1, Book, [map('status', { done: 'finished' })]);

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

  test('ContentPatch refuses a typo, a null on a required field, and a bad enum', () => {
    const ok: ContentPatch<BookContent> = { pages: null, status: 'finished' };
    // @ts-expect-error a typo'd key
    const typo: ContentPatch<BookContent> = { titel: 'x' };
    // @ts-expect-error a required field can be replaced but not removed
    const nullRequired: ContentPatch<BookContent> = { title: null };
    // @ts-expect-error a value outside the enum
    const wrongEnum: ContentPatch<BookContent> = { status: 'paused' };
    expect([ok, typo, nullRequired, wrongEnum]).toHaveLength(4);
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
      await books.patchContent(book.id, { pages: 412 }),
      await books.patchContent(book.id, { pages: 413 }),
      await books.editAssociations(book.id, [{ op: 'add', association: TAG }]),
      await books.editAssociations(book.id, [{ op: 'remove', association: TAG }]),
      await books.editAssociations(book.id, [{ op: 'add', association: TAG }]),
      await books.editAccess(book.id, [{ op: 'add', association: share('read') }]),
      await books.editAccess(book.id, [{ op: 'remove', association: share('read') }]),
      await books.editAccess(book.id, [{ op: 'add', association: share('read') }]),
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

  test('a content filter reaches older versions through a map, and flags the newer side', async () => {
    const book = await books.create({ title: 'Dune', status: 'finished' });
    const old = await createV1('Emma', 'done');
    await createV1('Hamlet', 'want');
    await stack.create(BookV3.id, { title: 'Ulysses', status: 'finished' });
    const page = await books.query({ filter: { content: { status: 'finished' } } });
    expect(page.records.map((r) => r.id).sort()).toEqual([book.id, old.id].sort());
    expect(page.records.find((r) => r.id === old.id)?.content.status).toBe('finished');
    expect(page.misfits).toEqual([]);
    expect(page.skipped).toEqual({ older: false, newer: true });
  });

  test('an older record holding the value a map also produces is flagged, not matched', async () => {
    // An enum widens in place, so @1 can come to hold a value its handle
    // does not list.
    await stack.defineType({
      ...BookV1,
      schema: {
        ...BookV1.schema,
        status: { kind: 'enum', values: ['want', 'reading', 'done', 'finished'], required: true },
      },
    });
    await createV1('Emma', 'finished');
    const page = await books.query({ filter: { content: { status: 'finished' } } });
    expect(page.records).toEqual([]);
    expect(page.skipped).toEqual({ older: true, newer: false });
  });

  test('a value no older value maps to drops the older arm without a skip', async () => {
    await createV1('Emma', 'done');
    // A value the handle does not list is filtered for with a cast.
    const page = await books.query({ filter: { content: { status: 'done' as never } } });
    expect(page.records).toEqual([]);
    expect(page.skipped).toEqual({ older: false, newer: false });
  });

  test('a field an older version gained in place is found under its own name', async () => {
    await stack.defineType({
      ...BookV1,
      schema: { ...BookV1.schema, pages: { kind: 'number' } },
    });
    const old = await stack.create(BookV1.id, { title: 'Emma', status: 'want', pages: 474 });
    await createV1('Dune');
    const page = await books.query({ filter: { content: { pages: 474 } } });
    expect(page.records.map((r) => r.id)).toEqual([old.id]);
    expect(page.skipped).toEqual({ older: false, newer: false });
    const sorted = await books.query({ sort: { contentField: 'pages' } });
    expect(sorted.records[0].id).toBe(old.id);
  });

  test('a field no step produces holds what an older record stores there', async () => {
    const book = await books.create({ title: 'Dune', status: 'want', pages: 412 });
    const old = await createV1();
    const absent = await books.query({ filter: { content: { pages: null } } });
    expect(absent.records.map((r) => r.id)).toEqual([old.id]);
    expect(absent.skipped).toEqual({ older: false, newer: false });
    const present = await books.query({ filter: { contentPresent: ['pages'] } });
    expect(present.records.map((r) => r.id)).toEqual([book.id]);
    expect(present.skipped).toEqual({ older: false, newer: false });
  });

  test('an undefined content value is a filter, as an adapter reads it', async () => {
    await books.create({ title: 'Dune', status: 'want' });
    await createV1();
    const page = await books.query({ filter: { content: { pages: undefined } } });
    expect(page.records).toHaveLength(2);
    expect(page.skipped).toEqual({ older: false, newer: false });
  });

  test('a content sort orders records at every version it reaches as one listing', async () => {
    await books.create({ title: 'Dune', status: 'want' });
    await createV1('Anathem');
    await books.create({ title: 'Middlemarch', status: 'want' });
    await createV1('Emma');
    const page = await books.query({ sort: { contentField: 'title' } });
    expect(page.records.map((r) => r.content.title)).toEqual([
      'Anathem',
      'Dune',
      'Emma',
      'Middlemarch',
    ]);
    expect(page.skipped).toEqual({ older: false, newer: false });
  });

  test('a sort on a mapped field narrows to the versions that keep its order', async () => {
    const book = await books.create({ title: 'Dune', status: 'want' });
    await createV1();
    const page = await books.query({ sort: { contentField: 'status' } });
    expect(page.records.map((r) => r.id)).toEqual([book.id]);
    expect(page.skipped).toEqual({ older: true, newer: false });
  });

  test('skipped is reported on the first page only', async () => {
    await books.create({ title: 'Dune', status: 'want' });
    await books.create({ title: 'Emma', status: 'want' });
    await createV1();
    const first = await books.query({ sort: { contentField: 'status' }, limit: 1 });
    expect(first.skipped).toEqual({ older: true, newer: false });
    const second = await books.query({
      sort: { contentField: 'status' },
      limit: 1,
      cursor: first.cursor!,
    });
    expect(second.records).toHaveLength(1);
    expect(second).not.toHaveProperty('skipped');
  });

  test('skipped applies the rest of the filter', async () => {
    await books.create({ title: 'Dune', status: 'want' });
    await createV1();
    await stack.create(BookV3.id, { title: 'Ulysses', status: 'want' });
    const page = await books.query({
      filter: { tags: ['fantasy'] },
      sort: { contentField: 'status' },
    });
    expect(page.skipped).toEqual({ older: false, newer: false });
  });

  test('a query without content keys reads the whole family and flags nothing', async () => {
    await books.create({ title: 'Dune', status: 'want' });
    await createV1();
    const page = await books.query({ filter: { content: {}, contentPresent: [] } });
    expect(page.records).toHaveLength(2);
    expect(page.skipped).toEqual({ older: false, newer: false });
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
      migrations: [migration(Book, BookV3, [])],
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
    await expect(
      books.editAssociations(shelf.id, [{ op: 'add', association: TAG }]),
    ).rejects.toThrow(StackNotFoundError);
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

  test('a write that leaves content alone returns an older record migrated, unwritten', async () => {
    const old = await createV1();
    const tagged = await books.editAssociations(old.id, [{ op: 'add', association: TAG }]);
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
    const err = await books
      .editAssociations(newer.id, [{ op: 'add', association: TAG }])
      .catch((e: unknown) => e);
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

  test('subscribe() drops typeId from an untyped caller', async () => {
    const seen: string[] = [];
    const stop = await books.subscribe((c) => seen.push(c.recordId), {
      filter: { typeId: Shelf.id },
    } as never);
    const book = await books.create({ title: 'Dune', status: 'want' });
    await settle();
    stop();
    expect(seen).toEqual([book.id]);
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
      migrations: [
        bookV1ToV2,
        migration(Shelf, Book, [rename('name', 'title'), add('status', 'want')]),
      ],
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

const TaskV1 = typeHandle({
  id: 'com.example.tasks/task@1',
  name: 'Task',
  schema: {
    author: { kind: 'string', required: true },
    status: { kind: 'enum', values: ['open', 'done'], required: true },
    archived: { kind: 'boolean' },
  },
});

const TaskV2 = typeHandle({
  id: 'com.example.tasks/task@2',
  name: 'Task',
  migratesFrom: TaskV1,
  schema: {
    by: { kind: 'string', required: true },
    status: { kind: 'enum', values: ['open', 'finished'], required: true },
    priority: { kind: 'enum', values: ['high', 'low', 'normal'], required: true },
    slug: { kind: 'string' },
  },
});

const Task = typeHandle({
  id: 'com.example.tasks/task@3',
  name: 'Task',
  migratesFrom: TaskV2,
  schema: {
    owner: { kind: 'string', required: true },
    status: TaskV2.schema.status,
    priority: TaskV2.schema.priority,
    slug: TaskV2.schema.slug,
  },
});

const TASK_MIGRATIONS = [
  migration(TaskV1, TaskV2, [
    rename('author', 'by'),
    map('status', { done: 'finished' }),
    add('priority', 'normal'),
    drop('archived'),
    derive('slug', (c) => c.author.toLowerCase()),
  ]),
  migration(TaskV2, Task, [rename('by', 'owner')]),
];

describe.each([
  ['Stack', (s: Stack): StackClient => s],
  ['ScopedStack', (s: Stack): StackClient => s.asEntity(OWNER)],
] as const)('content queries across a migration chain, on %s', (_name, view) => {
  let adapter: MemoryAdapter;
  let stack: Stack;

  const open = async (filterArms = 64, sortKeys = 64) => {
    adapter = await MemoryAdapter.open({ ownerEntityId: OWNER, timezone: 'UTC' });
    (adapter as { capabilities: StackClient['capabilities'] }).capabilities = {
      ...adapter.capabilities,
      filter: { ...adapter.capabilities.filter, contentByType: filterArms },
      sort: { ...adapter.capabilities.sort, contentFieldByType: sortKeys },
    };
    stack = await Stack.open(adapter, { migrations: TASK_MIGRATIONS });
    for (const type of [TaskV1, TaskV2, Task]) await stack.defineType(type);
  };

  /** One task at each version, all owned by `owner`. */
  const seed = async (owner: string) => [
    await stack.create(TaskV1.id, { author: owner, status: 'open' }),
    await stack.create(TaskV2.id, { by: owner, status: 'open', priority: 'high', slug: 'x' }),
    await stack.create(Task.id, { owner, status: 'open', priority: 'low' }),
  ];

  const tasks = () => view(stack).collection(Task);

  beforeEach(() => open());

  test('a filter on a field renamed across two steps reaches every version', async () => {
    const ada = await seed('Ada');
    await seed('Grace');
    const page = await tasks().query({ filter: { content: { owner: 'Ada' } } });
    expect(page.records.map((r) => r.id).sort()).toEqual(ada.map((r) => r.id).sort());
    expect(page.records.map((r) => r.typeId)).toEqual([Task.id, Task.id, Task.id]);
    expect(page.skipped).toEqual({ older: false, newer: false });
  });

  test('a sort on a renamed field orders every version as one listing', async () => {
    await stack.create(TaskV1.id, { author: 'Cleo', status: 'open' });
    await stack.create(Task.id, { owner: 'Ada', status: 'open', priority: 'low' });
    await stack.create(TaskV2.id, { by: 'Bea', status: 'open', priority: 'low' });
    const page = await tasks().query({ sort: { contentField: 'owner', direction: 'desc' } });
    expect(page.records.map((r) => r.content.owner)).toEqual(['Cleo', 'Bea', 'Ada']);
  });

  test('a filter on an added field is decided in core, keeping or dropping the older arm', async () => {
    const [v1] = await seed('Ada');
    const normal = await tasks().query({ filter: { content: { priority: 'normal' } } });
    expect(normal.records.map((r) => r.id)).toEqual([v1.id]);
    const high = await tasks().query({ filter: { content: { priority: 'high' } } });
    expect(high.records.map((r) => r.content.priority)).toEqual(['high']);
    expect(high.skipped).toEqual({ older: false, newer: false });
  });

  test('a sort on an added field orders the older records as the constant', async () => {
    await seed('Ada');
    const page = await tasks().query({ sort: { contentField: 'priority' } });
    expect(page.records.map((r) => [r.content.priority, r.content.owner])).toEqual([
      ['high', 'Ada'],
      ['low', 'Ada'],
      ['normal', 'Ada'],
    ]);
  });

  test('a filter on a derived field narrows the versions before the derivation', async () => {
    const [, v2] = await seed('Ada');
    const page = await tasks().query({ filter: { content: { slug: 'x' } } });
    expect(page.records.map((r) => r.id)).toEqual([v2.id]);
    expect(page.skipped).toEqual({ older: true, newer: false });
  });

  test('pages through every version under a translated sort', async () => {
    for (const owner of ['Fay', 'Ada', 'Eve', 'Bea', 'Dot', 'Cleo']) await seed(owner);
    const owners: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await tasks().query({
        filter: { content: { status: 'open' } },
        sort: { contentField: 'owner' },
        limit: 4,
        ...(cursor && { cursor }),
      });
      owners.push(...page.records.map((r) => r.content.owner));
      cursor = page.cursor ?? undefined;
    } while (cursor);
    expect(owners).toEqual(
      ['Ada', 'Bea', 'Cleo', 'Dot', 'Eve', 'Fay'].flatMap((owner) => [owner, owner, owner]),
    );
  });

  test('a later page reuses the versions the first page chose, without listing types', async () => {
    adapter = await MemoryAdapter.open({ ownerEntityId: OWNER, timezone: 'UTC' });
    stack = await Stack.open(adapter, { migrations: TASK_MIGRATIONS });
    await stack.defineType(TaskV2);
    await stack.defineType(Task);
    for (const owner of ['Ada', 'Bea']) {
      await stack.create(TaskV2.id, { by: owner, status: 'open', priority: 'low' });
      await stack.create(Task.id, { owner, status: 'open', priority: 'low' });
    }
    const query = { sort: { contentField: 'owner' as const }, limit: 2 };
    const first = await tasks().query(query);

    await stack.defineType(TaskV1);
    await stack.create(TaskV1.id, { author: 'Ada', status: 'open' });
    const listTypes = vi.spyOn(stack, 'listTypes');
    const second = await tasks().query({ ...query, cursor: first.cursor! });

    expect([...first.records, ...second.records].map((r) => r.content.owner)).toEqual([
      'Ada',
      'Ada',
      'Bea',
      'Bea',
    ]);
    expect(listTypes).not.toHaveBeenCalled();
  });

  test('an adapter that declines the shape gets the handle-only query', async () => {
    await open(0, 0);
    const [, , v3] = await seed('Ada');
    const filtered = await tasks().query({ filter: { content: { owner: 'Ada' } } });
    expect(filtered.records.map((r) => r.id)).toEqual([v3.id]);
    expect(filtered.skipped).toEqual({ older: true, newer: false });
    const sorted = await tasks().query({ sort: { contentField: 'owner' } });
    expect(sorted.records.map((r) => r.id)).toEqual([v3.id]);
    expect(sorted.skipped).toEqual({ older: true, newer: false });
  });

  test('an adapter with a lower cap gets the newest versions that fit', async () => {
    await open(2);
    const [, v2, v3] = await seed('Ada');
    const page = await tasks().query({ filter: { content: { owner: 'Ada' } } });
    expect(page.records.map((r) => r.id).sort()).toEqual([v2.id, v3.id].sort());
    expect(page.skipped).toEqual({ older: true, newer: false });
  });

  test('a migration not built by migration() is narrowed', async () => {
    stack = await Stack.open(adapter, {
      migrations: [
        TASK_MIGRATIONS[0],
        {
          from: TaskV2.id,
          to: Task.id,
          steps: [],
          migrate: (c: Record<string, unknown>) => TASK_MIGRATIONS[1].migrate(c as never),
        },
      ],
    });
    const [, , v3] = await seed('Ada');
    const page = await tasks().query({ filter: { content: { owner: 'Ada' } } });
    expect(page.records.map((r) => r.id)).toEqual([v3.id]);
    expect(page.skipped).toEqual({ older: true, newer: false });
  });
});

describe('a collection whose migration throws', () => {
  test('subscribe() still delivers the change, without its record', async () => {
    const stack = await Stack.open(
      await MemoryAdapter.open({ ownerEntityId: OWNER, timezone: 'UTC' }),
      {
        migrations: [
          migration(BookV1, Book, [
            map('status', { done: 'finished' }),
            derive('title', () => {
              throw new TypeError('broken migration');
            }),
          ]),
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

describe('content filter and sort typing', () => {
  const Contact = typeHandle({
    id: 'com.example.people/contact@1',
    name: 'Contact',
    schema: {
      name: { kind: 'string', required: true },
      status: { kind: 'enum', values: ['active', 'archived'], required: true },
      age: { kind: 'number' },
      address: {
        kind: 'object',
        properties: {
          city: { kind: 'string' },
          geo: { kind: 'object', properties: { lat: { kind: 'number' } } },
        },
      },
      emails: {
        kind: 'array',
        items: { kind: 'object', properties: { value: { kind: 'string', required: true } } },
      },
      tags: { kind: 'array', items: { kind: 'string' } },
      extra: { kind: 'object', open: true },
      bag: { kind: 'array', open: true },
    },
  });
  type Q = CollectionQuery<ContentOf<typeof Contact.schema>>;

  test('derives paths and sortable fields from the content type', () => {
    type C = ContentOf<typeof Contact.schema>;
    expectTypeOf<SortableFieldOf<C>>().toEqualTypeOf<'name' | 'status' | 'age'>();
    expectTypeOf<ContentPathOf<C>>().toEqualTypeOf<
      | 'name'
      | 'status'
      | 'age'
      | 'address'
      | 'address.city'
      | 'address.geo'
      | 'address.geo.lat'
      | 'emails'
      | 'emails.value'
      | 'tags'
      | 'extra'
      | `extra.${string}`
      | 'bag'
      | `bag.${string}`
    >();
  });

  test('accepts declared paths, element values, any suffix below an open node, and null', async () => {
    const stack = await Stack.open(
      await MemoryAdapter.open({ ownerEntityId: OWNER, timezone: 'UTC' }),
    );
    await stack.defineType(Contact);
    const contacts = stack.collection(Contact);
    const ada = await contacts.create({
      name: 'Ada',
      status: 'active',
      address: { city: 'London', geo: { lat: 51.5 } },
      emails: [{ value: 'ada@example.com' }],
      tags: ['starred'],
      extra: { source: { kind: 'import' } },
      bag: [1],
    });
    await contacts.create({ name: 'Bea', status: 'archived', age: 40 });
    const { records } = await contacts.query({
      filter: {
        content: {
          status: 'active',
          'address.city': 'London',
          'address.geo.lat': 51.5,
          'emails.value': 'ada@example.com',
          tags: 'starred',
          'extra.source.kind': 'import',
          bag: 1,
          age: null,
        },
        contentPresent: ['address.city', 'extra.source'],
      },
      sort: { contentField: 'name', direction: 'desc' },
    });
    expect(records.map((r) => r.id)).toEqual([ada.id]);
  });

  test('refuses a typo, a value outside an enum, a wrong nested type and a path through a scalar', () => {
    // @ts-expect-error a typo'd field
    const typo: Q = { filter: { content: { stauts: 'active' } } };
    // @ts-expect-error a value outside the enum
    const badEnum: Q = { filter: { content: { status: 'actvie' } } };
    // @ts-expect-error a wrong value type at a nested path
    const badNested: Q = { filter: { content: { 'address.geo.lat': 'north' } } };
    // @ts-expect-error a path through a scalar
    const throughScalar: Q = { filter: { content: { 'name.first': 'Ada' } } };
    // @ts-expect-error an object never equals a filter value
    const object: Q = { filter: { content: { address: { city: 'Lisbon' } } } };
    // @ts-expect-error nor does an element of an array of objects
    const element: Q = { filter: { content: { emails: { value: 'ada@example.com' } } } };
    // @ts-expect-error nor an open object itself
    const open: Q = { filter: { content: { extra: {} } } };
    // @ts-expect-error a typo'd presence path
    const badPresent: Q = { filter: { contentPresent: ['adress.city'] } };
    expect([
      typo,
      badEnum,
      badNested,
      throughScalar,
      object,
      element,
      open,
      badPresent,
    ]).toHaveLength(8);
  });

  test('sorts by top-level scalars only', () => {
    // @ts-expect-error a nested field
    const nested: Q = { sort: { contentField: 'address.city' } };
    // @ts-expect-error an object field
    const object: Q = { sort: { contentField: 'address' } };
    // @ts-expect-error a typo'd field
    const typo: Q = { sort: { contentField: 'nmae' } };
    expect([nested, object, typo]).toHaveLength(3);
  });

  test('types paths deeper than the typing limit without exceeding the compiler', () => {
    type Obj<P> = { kind: 'object'; properties: P };
    type DeepQ = CollectionQuery<
      ContentOf<{
        a: Obj<{
          b: Obj<{
            c: Obj<{ d: Obj<{ e: Obj<{ f: Obj<{ g: Obj<{ h: { kind: 'number' } }> }> }> }> }>;
          }>;
        }>;
      }>
    >;
    const ok: DeepQ = { filter: { content: { 'a.b.c.d.e': null, 'a.b.c.d.e.f.anything': 1 } } };
    // @ts-expect-error the sixth segment is still typed
    const sixth: DeepQ = { filter: { content: { 'a.b.c.d.e.x': 1 } } };
    // @ts-expect-error a typo above the limit is still caught
    const typo: DeepQ = { filter: { content: { 'a.x': 1 } } };
    expect([ok, sixth, typo]).toHaveLength(3);
  });

  test('an untyped handle takes any path and sort field', () => {
    const ok: CollectionQuery<ContentOf<ReadonlyTypeSchema>> = {
      filter: { content: { anything: 1, 'a.b': 'x' }, contentPresent: ['q.r'] },
      sort: { contentField: 'x' },
    };
    expect(ok).toBeDefined();
  });
});
