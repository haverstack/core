import { describe, test, expect, expectTypeOf } from 'vitest';
import { Stack } from '../src/stack/stack.js';
import { MemoryAdapter } from '../src/testing.js';
import { migration, typeHandle } from '../src/type-handle.js';
import type { ContentOf, StoredContentOf, UnlistedValue } from '../src/type-handle.js';
import { StackBadRequestError, StackMigrationError } from '../src/errors.js';
import type { TypeId, TypeSchema } from '../src/types/index.js';

const OWNER = 'owner-123';

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

describe('StoredContentOf', () => {
  test('reads an enum as its listed values or any other string', () => {
    expectTypeOf<StoredContentOf<typeof Book.schema>>().toEqualTypeOf<{
      title: string;
      status: 'want' | 'reading' | 'finished' | 'abandoned' | UnlistedValue;
      pages?: number;
    }>();
  });

  test('reads an enum nested in an array or object the same way', () => {
    const Nested = typeHandle({
      id: 'com.example/nested@1',
      name: 'Nested',
      schema: {
        tags: { kind: 'array', items: { kind: 'enum', values: ['x'] }, required: true },
        meta: {
          kind: 'object',
          required: true,
          properties: { mood: { kind: 'enum', values: ['y'], required: true } },
        },
      },
    });
    expect(Nested.baseId).toBe('com.example/nested');
    expectTypeOf<StoredContentOf<typeof Nested.schema>>().toEqualTypeOf<{
      tags: ('x' | UnlistedValue)[];
      meta: { mood: 'y' | UnlistedValue };
    }>();
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
      expectTypeOf(c).toEqualTypeOf<StoredContentOf<typeof BookV1.schema>>();
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

  test('carries a value the source handle does not list through', () => {
    const m = migration(BookV1, Book, (c) => c);
    expect(m.migrate({ title: 'Dune', status: 'paused' })).toEqual({
      title: 'Dune',
      status: 'paused',
    });
  });

  test('refuses at compile time a lookup keyed on only the listed values', () => {
    const renamed = { want: 'want', reading: 'reading', done: 'finished' } as const;
    // @ts-expect-error a stored status the source does not list has no entry
    migration(BookV1, Book, (c) => ({ ...c, status: renamed[c.status] }));
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
