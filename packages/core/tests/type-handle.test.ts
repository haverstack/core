import { describe, test, expect, expectTypeOf, beforeEach } from 'vitest';
import { Stack } from '../src/stack.js';
import { MemoryAdapter } from '../src/testing.js';
import { typeHandle } from '../src/type-handle.js';
import type { ContentOf, PatchOf, TypedRecord } from '../src/type-handle.js';
import { StackBadRequestError, StackMigrationError, StackValidationError } from '../src/errors.js';
import type { StackClient } from '../src/stack.js';
import type { TypeSchema } from '../src/types.js';

const OWNER = 'owner-123';

const Book = typeHandle('com.example.reading/book@2', {
  title: { kind: 'string', required: true },
  status: { kind: 'string', enum: ['want', 'reading', 'finished', 'abandoned'], required: true },
  pages: { kind: 'number' },
});

const Shelf = typeHandle('com.example.reading/shelf@1', {
  name: { kind: 'string', required: true },
});

type BookContent = ContentOf<typeof Book.schema>;

// -------------------------------------------------------
// The mapping, one assertion per field kind
// -------------------------------------------------------

const Everything = typeHandle('com.example/everything@1', {
  s: { kind: 'string', required: true },
  e: { kind: 'string', enum: ['a', 'b'], required: true },
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
  test('carries the id, its family and the schema', () => {
    expect(Book.id).toBe('com.example.reading/book@2');
    expect(Book.baseId).toBe('com.example.reading/book');
    expect(Book.schema.title).toEqual({ kind: 'string', required: true });
  });

  test('refuses a malformed TypeId', () => {
    expect(() => typeHandle('book', {})).toThrow(StackBadRequestError);
  });

  test('rejects a schema the field kinds do not describe', () => {
    // @ts-expect-error an unknown kind
    typeHandle('com.example/x@1', { a: { kind: 'bigint' } });
    // @ts-expect-error an array with neither items nor open
    typeHandle('com.example/x@1', { a: { kind: 'array' } });
  });

  test('core TypeSchema fits the literal schema type', () => {
    const fromCore: TypeSchema = { a: { kind: 'string', enum: ['x'] } };
    expect(typeHandle('com.example/x@1', fromCore).schema).toBe(fromCore);
  });
});

// -------------------------------------------------------
// Typed reads and writes
// -------------------------------------------------------

describe.each([
  ['Stack', (s: Stack): StackClient => s],
  ['ScopedStack', (s: Stack): StackClient => s.asEntity(OWNER)],
] as const)('typed reads and writes on %s', (_name, view) => {
  let stack: Stack;
  let client: ReturnType<typeof view>;

  beforeEach(async () => {
    stack = await Stack.open(await MemoryAdapter.open({ ownerEntityId: OWNER, timezone: 'UTC' }));
    await stack.defineType({ ...Book, name: 'Book' });
    await stack.defineType({ ...Shelf, name: 'Shelf' });
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
    await stack.defineType({
      id: 'com.example.reading/book@3',
      name: 'Book',
      schema: { ...Book.schema, isbn: { kind: 'string' } },
      migratesFrom: Book.id,
    });
    stack.registerMigration({
      from: Book.id,
      to: 'com.example.reading/book@3',
      migrate: (c) => c,
    });
    await expect(client.get(Book, book.id)).rejects.toThrow(/book@3, not .*book@2/);
  });

  test('get() throws when the app has not registered the migration', async () => {
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
          kind: 'string',
          enum: ['want', 'reading', 'finished', 'abandoned', 'paused'],
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

  test('a typed write to a record of another Type throws before writing', async () => {
    const shelf = await client.create(Shelf, { name: 'Fiction' });
    await expect(client.patchContent(Book, shelf.id, { title: 'x' })).rejects.toThrow(
      StackBadRequestError,
    );
    expect((await stack.get(shelf.id))?.version).toBe(shelf.version);
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
  test('accepts a handle with a name', async () => {
    const stack = await Stack.open(
      await MemoryAdapter.open({ ownerEntityId: OWNER, timezone: 'UTC' }),
    );
    const type = await stack.defineType({ ...Book, name: 'Book' });
    expect(type.id).toBe(Book.id);
    expect(type.schema).toEqual(Book.schema);
  });
});
