import { describe, test, expect, expectTypeOf, beforeEach, vi } from 'vitest';
import { Stack } from '../src/stack.js';
import { MemoryAdapter } from '../src/testing.js';
import { migration, narrowRecord, typeHandle } from '../src/type-handle.js';
import type { ContentOf, PatchOf, TypedChange, TypedRecord } from '../src/type-handle.js';
import {
  StackBadRequestError,
  StackMigrationError,
  StackNotFoundError,
  StackValidationError,
} from '../src/errors.js';
import type { StackClient } from '../src/stack.js';
import type { StackRecord, TypeId, TypeSchema } from '../src/types.js';

const OWNER = 'owner-123';

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

const Shelf = typeHandle({
  id: 'com.example.reading/shelf@1',
  name: 'Shelf',
  schema: { name: { kind: 'string', required: true } },
});

type BookContent = ContentOf<typeof Book.schema>;

// -------------------------------------------------------
// The mapping, one assertion per field kind
// -------------------------------------------------------

const Everything = typeHandle({
  id: 'com.example/everything@1',
  name: 'Everything',
  schema: {
    s: { kind: 'string', required: true },
    e: { kind: 'enum', values: ['a', 'b'], required: true },
    t: { kind: 'text', required: true },
    n: { kind: 'number', required: true },
    b: { kind: 'boolean', required: true },
    d: { kind: 'date', required: true },
    r: { kind: 'record-ref', required: true },
    f: { kind: 'file-ref', required: true },
    tags: { kind: 'array', items: { kind: 'string' }, required: true },
    grid: { kind: 'array', items: { kind: 'array', items: { kind: 'number' } }, required: true },
    bag: { kind: 'array', open: true, required: true },
    nested: {
      kind: 'object',
      required: true,
      properties: { inner: { kind: 'boolean', required: true }, note: { kind: 'string' } },
    },
    free: { kind: 'object', open: true, required: true },
    maybe: { kind: 'string' },
    explicitlyOptional: { kind: 'number', required: false },
  },
});

describe('ContentOf', () => {
  test('maps every field kind', () => {
    expect(Everything.baseId).toBe('com.example/everything');
    expectTypeOf<ContentOf<typeof Everything.schema>>().toEqualTypeOf<{
      s: string;
      e: 'a' | 'b';
      t: string;
      n: number;
      b: boolean;
      d: string;
      r: string;
      f: string;
      tags: string[];
      grid: number[][];
      bag: unknown[];
      nested: { inner: boolean; note?: string };
      free: Record<string, unknown>;
      maybe?: string;
      explicitlyOptional?: number;
    }>();
  });

  test('derives the example from the issue', () => {
    expectTypeOf<BookContent>().toEqualTypeOf<{
      title: string;
      status: 'want' | 'reading' | 'finished' | 'abandoned';
      pages?: number;
    }>();
  });

  test('rejects content the schema does not describe', () => {
    // @ts-expect-error a value outside the enum
    const wrongEnum: BookContent = { title: 'x', status: 'paused' };
    // @ts-expect-error a required field is missing
    const missing: BookContent = { status: 'want' };
    expect([wrongEnum, missing]).toHaveLength(2);
  });
});

describe('PatchOf', () => {
  test('makes every field optional and allows null only on optional fields', () => {
    expectTypeOf<PatchOf<typeof Book.schema>>().toEqualTypeOf<{
      title?: string;
      status?: 'want' | 'reading' | 'finished' | 'abandoned';
      pages?: number | null;
    }>();
  });

  test('rejects a typo, a null on a required field, and a value outside the enum', () => {
    const ok: PatchOf<typeof Book.schema> = { pages: null, status: 'finished' };
    // @ts-expect-error a typo'd key
    const typo: PatchOf<typeof Book.schema> = { titel: 'x' };
    // @ts-expect-error a required field can be replaced but not removed
    const nullRequired: PatchOf<typeof Book.schema> = { title: null };
    // @ts-expect-error a value outside the enum
    const wrongEnum: PatchOf<typeof Book.schema> = { status: 'paused' };
    expect([ok, typo, nullRequired, wrongEnum]).toHaveLength(4);
  });
});

describe('typeHandle()', () => {
  test('carries the id, its family, the name, the schema and what it migrates from', () => {
    expect(Book.id).toBe('com.example.reading/book@2');
    expect(Book.baseId).toBe('com.example.reading/book');
    expect(Book.name).toBe('Book');
    expect(Book.schema.title).toEqual({ kind: 'string', required: true });
    expect(Book.migratesFrom).toBe(BookV1.id);
  });

  test('takes migratesFrom as a TypeId too', () => {
    const fromId = typeHandle({
      id: 'com.example.reading/book@2',
      name: 'Book',
      schema: {},
      migratesFrom: BookV1.id,
    });
    expect(fromId.migratesFrom).toBe(BookV1.id);
  });

  test('leaves migratesFrom off a first version', () => {
    expect('migratesFrom' in BookV1).toBe(false);
  });

  test('takes migratesFrom only as an earlier version of its own family', () => {
    const bookV3 = (migratesFrom: unknown) => () =>
      typeHandle({
        id: 'com.example.reading/book@3',
        name: 'Book',
        schema: {},
        migratesFrom: migratesFrom as TypeId,
      });
    expect(bookV3(Shelf)).toThrow(StackBadRequestError);
    expect(bookV3('com.example.reading/book@3')).toThrow(StackBadRequestError);
    expect(bookV3('com.example.reading/book@4')).toThrow(StackBadRequestError);
    expect(bookV3('book')).toThrow(StackBadRequestError);
    expect(bookV3(null)).toThrow(StackBadRequestError);
    expect(bookV3(BookV1)().migratesFrom).toBe(BookV1.id);
  });

  test('refuses a malformed TypeId', () => {
    expect(() => typeHandle({ id: 'book', name: 'Book', schema: {} })).toThrow(
      StackBadRequestError,
    );
  });

  test('rejects a schema the field kinds do not describe', () => {
    // @ts-expect-error an unknown kind
    typeHandle({ id: 'com.example/x@1', name: 'X', schema: { a: { kind: 'bigint' } } });
    // @ts-expect-error an array with neither items nor open
    typeHandle({ id: 'com.example/x@1', name: 'X', schema: { a: { kind: 'array' } } });
  });

  test('core TypeSchema fits the literal schema type', () => {
    const fromCore: TypeSchema = { a: { kind: 'enum', values: ['x'] } };
    expect(typeHandle({ id: 'com.example/x@1', name: 'X', schema: fromCore }).schema).toBe(
      fromCore,
    );
  });
});

describe('migration()', () => {
  test('types the function from both handles', () => {
    const m = migration(BookV1, Book, (c) => {
      expectTypeOf(c).toEqualTypeOf<ContentOf<typeof BookV1.schema>>();
      return { ...c, status: c.status === 'done' ? 'finished' : c.status };
    });
    expect(m.from).toBe(BookV1.id);
    expect(m.to).toBe(Book.id);
    expect(m.migrate({ title: 'Dune', status: 'done' })).toEqual({
      title: 'Dune',
      status: 'finished',
    });
  });

  test('refuses at compile time content missing a required field', () => {
    // @ts-expect-error `status` is required in the target
    migration(BookV1, Book, (c) => ({ title: c.title }));
  });

  test('refuses at compile time a value outside the target enum', () => {
    // @ts-expect-error 'done' is not one of the target's statuses
    migration(BookV1, Book, (c) => ({ ...c }));
  });

  test('refuses a target in the same family that does not migrate from the source', () => {
    const BookV3 = typeHandle({
      id: 'com.example.reading/book@3',
      name: 'Book',
      schema: Book.schema,
      migratesFrom: Book,
    });
    expect(() => migration(BookV1, BookV3, () => ({ title: 'x', status: 'want' }))).toThrow(
      `Cannot migrate "${BookV1.id}" to "${BookV3.id}": "${BookV3.id}" migrates from "${Book.id}".`,
    );
    expect(() => migration(Book, BookV1, (c) => ({ title: c.title, status: 'want' }))).toThrow(
      StackMigrationError,
    );
  });

  test('builds a step into another family without lineage', () => {
    const m = migration(Shelf, Book, (c) => ({ title: c.name, status: 'want' }));
    expect(m.migrate({ name: 'Fiction' })).toEqual({ title: 'Fiction', status: 'want' });
  });
});

// -------------------------------------------------------
// Typed reads and writes
// -------------------------------------------------------

describe('narrowRecord()', () => {
  test('refuses a non-string value in an enum field', () => {
    const record = { id: 'r1', typeId: Book.id, content: { title: 'Dune', status: 3 } };
    expect(() => narrowRecord(Book, record as unknown as StackRecord)).toThrow(
      StackValidationError,
    );
  });
});

describe.each([
  ['Stack', (s: Stack): StackClient => s],
  ['ScopedStack', (s: Stack): StackClient => s.asEntity(OWNER)],
] as const)('typed reads and writes on %s', (_name, view) => {
  let adapter: MemoryAdapter;
  let stack: Stack;
  let client: ReturnType<typeof view>;

  beforeEach(async () => {
    adapter = await MemoryAdapter.open({ ownerEntityId: OWNER, timezone: 'UTC' });
    stack = await Stack.open(adapter);
    await stack.defineType(Book);
    await stack.defineType(Shelf);
    client = view(stack);
  });

  test('create() returns content typed from the handle', async () => {
    const book = await client.create(Book, { title: 'Dune', status: 'want' });
    expectTypeOf(book).toEqualTypeOf<TypedRecord<typeof Book.schema>>();
    expect(book.typeId).toBe(Book.id);
    expect(book.content.title).toBe('Dune');
  });

  test('create() refuses content outside the schema at compile time', async () => {
    // @ts-expect-error a value outside the enum
    await client.create(Book, { title: 'x', status: 'paused' }).catch(() => undefined);
  });

  test('get() round-trips a record as typed content', async () => {
    const created = await client.create(Book, { title: 'Dune', status: 'want' });
    const got = await client.get(Book, created.id);
    expectTypeOf(got).toEqualTypeOf<TypedRecord<typeof Book.schema> | null>();
    expect(got?.content).toEqual({ title: 'Dune', status: 'want' });
  });

  test('get() answers null for a missing record', async () => {
    expect(await client.get(Book, 'nope')).toBeNull();
  });

  test('get() throws for a record of another Type', async () => {
    const shelf = await client.create(Shelf, { name: 'Fiction' });
    await expect(client.get(Book, shelf.id)).rejects.toThrow(
      `Record "${shelf.id}" is com.example.reading/shelf@1, not com.example.reading/book@2`,
    );
  });

  test('get() throws once the family has moved past the handle', async () => {
    const book = await client.create(Book, { title: 'Dune', status: 'want' });
    const BookV3 = typeHandle({
      id: 'com.example.reading/book@3',
      name: 'Book',
      schema: { ...Book.schema, isbn: { kind: 'string' } },
      migratesFrom: Book,
    });
    stack = await Stack.open(adapter, { migrations: [migration(Book, BookV3, (c) => c)] });
    await stack.defineType(BookV3);
    client = view(stack);
    await expect(client.get(Book, book.id)).rejects.toThrow(/book@3, not .*book@2/);
  });

  test('get() throws when the app was not passed the migration', async () => {
    const book = await client.create(Book, { title: 'Dune', status: 'want' });
    await stack.defineType({
      id: 'com.example.reading/book@3',
      name: 'Book',
      schema: Book.schema,
    });
    await expect(client.get(Book, book.id)).rejects.toThrow(StackMigrationError);
  });

  test('get() throws on an enum value the handle does not list', async () => {
    const book = await client.create(Book, { title: 'Dune', status: 'want' });
    // The writer's schema listed one more value than this reader's handle.
    await stack.defineType({
      id: Book.id,
      name: 'Book',
      schema: {
        ...Book.schema,
        status: {
          kind: 'enum',
          values: ['want', 'reading', 'finished', 'abandoned', 'paused'],
          required: true,
        },
      },
    });
    await stack.patchContent(book.id, { status: 'paused' });
    await expect(client.get(Book, book.id)).rejects.toThrow(StackValidationError);
  });

  test('get() reads a tombstone as null', async () => {
    const book = await client.create(Book, { title: 'Dune', status: 'want' });
    await client.delete(book.id);
    expect(await client.get(Book, book.id)).toBeNull();
  });

  test('query() returns typed records of the handle and hides tombstones', async () => {
    const live = await client.create(Book, { title: 'Dune', status: 'want' });
    const gone = await client.create(Book, { title: 'Emma', status: 'want' });
    await client.create(Shelf, { name: 'Fiction' });
    await client.delete(gone.id);

    const { records } = await client.query(Book);
    expectTypeOf(records).toEqualTypeOf<TypedRecord<typeof Book.schema>[]>();
    expect(records.map((r) => r.id)).toEqual([live.id]);
  });

  test('query() filters on content', async () => {
    await client.create(Book, { title: 'Dune', status: 'want' });
    await client.create(Book, { title: 'Emma', status: 'reading' });
    const { records } = await client.query(Book, { filter: { content: { status: 'reading' } } });
    expect(records.map((r) => r.content.title)).toEqual(['Emma']);
  });

  test('query() refuses includeDeleted', async () => {
    await expect(
      // @ts-expect-error typed reads do not offer includeDeleted
      client.query(Book, { filter: { includeDeleted: true } }),
    ).rejects.toThrow(StackBadRequestError);
  });

  test('query() throws on a record of the family at another version', async () => {
    await client.create(Book, { title: 'Dune', status: 'want' });
    await stack.defineType({ id: 'com.example.reading/book@3', name: 'Book', schema: Book.schema });
    await expect(client.query(Book)).rejects.toThrow(StackMigrationError);
  });

  test('patchContent() takes a typed patch and returns the typed record', async () => {
    const book = await client.create(Book, { title: 'Dune', status: 'want', pages: 412 });
    const updated = await client.patchContent(Book, book.id, { status: 'reading', pages: null });
    expectTypeOf(updated).toEqualTypeOf<TypedRecord<typeof Book.schema>>();
    expect(updated.content).toEqual({ title: 'Dune', status: 'reading' });
  });

  test('patchContent() refuses a typo, a null on a required field and a bad enum', async () => {
    const book = await client.create(Book, { title: 'Dune', status: 'want' });
    // @ts-expect-error a typo'd key
    await client.patchContent(Book, book.id, { titel: 'x' }).catch(() => undefined);
    // @ts-expect-error null on a required field
    await client.patchContent(Book, book.id, { title: null }).catch(() => undefined);
    // @ts-expect-error a value outside the enum
    await client.patchContent(Book, book.id, { status: 'paused' }).catch(() => undefined);
  });

  test('mutate() carries a typed contentPatch beside the other keys', async () => {
    const book = await client.create(Book, { title: 'Dune', status: 'want' });
    const updated = await client.mutate(Book, book.id, {
      contentPatch: { status: 'finished' },
      unlisted: true,
    });
    expect(updated.content.status).toBe('finished');
    expect(updated.unlistedAt).toBeDefined();
  });

  test("subscribe() delivers only the handle's Type, with the record typed", async () => {
    const seen: TypedChange<typeof Book.schema>[] = [];
    const stop = await client.subscribe(Book, (change) => seen.push(change), {
      includeRecords: true,
    });
    await client.create(Shelf, { name: 'Fiction' });
    const book = await client.create(Book, { title: 'Dune', status: 'want' });
    await settle();
    stop();

    expect(seen.map((c) => c.recordId)).toEqual([book.id]);
    expectTypeOf(seen[0].record).toEqualTypeOf<TypedRecord<typeof Book.schema> | undefined>();
    expect(seen[0].record?.content).toEqual({ title: 'Dune', status: 'want' });
  });

  test('subscribe() takes the rest of the change filter', async () => {
    const seen: string[] = [];
    const stop = await client.subscribe(Book, (c) => seen.push(c.kind), {
      filter: { kinds: ['removed'] },
    });
    const book = await client.create(Book, { title: 'Dune', status: 'want' });
    await client.delete(book.id);
    await settle();
    stop();
    expect(seen).toEqual(['removed']);
  });

  test('subscribe() withholds a record holding an enum value the handle does not list', async () => {
    const seen: TypedChange<typeof Book.schema>[] = [];
    const book = await client.create(Book, { title: 'Dune', status: 'want' });
    await stack.defineType({
      id: Book.id,
      name: 'Book',
      schema: {
        ...Book.schema,
        status: {
          kind: 'enum',
          values: ['want', 'reading', 'finished', 'abandoned', 'paused'],
          required: true,
        },
      },
    });
    const stop = await client.subscribe(Book, (change) => seen.push(change), {
      includeRecords: true,
    });
    await stack.patchContent(book.id, { status: 'paused' });
    await settle();
    stop();

    expect(seen).toHaveLength(1);
    expect(seen[0].recordId).toBe(book.id);
    expect(seen[0].record).toBeUndefined();
  });

  test('a typed write to a record of another family finds no record and writes nothing', async () => {
    const shelf = await client.create(Shelf, { name: 'Fiction' });
    await expect(client.patchContent(Book, shelf.id, { title: 'x' })).rejects.toThrow(
      StackNotFoundError,
    );
    expect((await stack.get(shelf.id))?.version).toBe(shelf.version);
  });

  test('a typed write to another version of the family throws before writing', async () => {
    await stack.defineType(BookV1);
    const old = await client.create(BookV1, { title: 'Dune', status: 'want' });
    await expect(client.patchContent(Book, old.id, { title: 'x' })).rejects.toThrow(
      `Record "${old.id}" is com.example.reading/book@1, not com.example.reading/book@2`,
    );
    await expect(
      client.mutate(Book, old.id, { associations: [{ kind: 'tag', label: 'x' }] }),
    ).rejects.toThrow(StackBadRequestError);
    expect(await adapter.getRecord(old.id)).toEqual(old);
  });

  test('a typed write reads the record no more often than an untyped one', async () => {
    const book = await client.create(Book, { title: 'Dune', status: 'want' });
    const spy = vi.spyOn(adapter, 'getRecord');
    await client.patchContent(book.id, { title: 'Emma' });
    const untyped = spy.mock.calls.length;
    spy.mockClear();
    await client.patchContent(Book, book.id, { title: 'Dune' });
    expect(spy.mock.calls.length).toBe(untyped);
    spy.mockRestore();
  });

  test('a typed write to a tombstone is refused as an untyped one is', async () => {
    const book = await client.create(Book, { title: 'Dune', status: 'want' });
    await client.delete(book.id);
    await expect(client.patchContent(Book, book.id, { title: 'x' })).rejects.toThrow(
      /soft-deleted/,
    );
  });
});

describe('defineType()', () => {
  test('accepts a handle as it is', async () => {
    const stack = await Stack.open(
      await MemoryAdapter.open({ ownerEntityId: OWNER, timezone: 'UTC' }),
    );
    const type = await stack.defineType(Book);
    expect(type.id).toBe(Book.id);
    expect(type.schema).toEqual(Book.schema);
  });
});
