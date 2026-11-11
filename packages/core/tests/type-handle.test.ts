import { describe, test, expect, expectTypeOf } from 'vitest';
import { Stack } from '../src/stack/stack.js';
import { MemoryAdapter } from '../src/testing.js';
import { migration, typeHandle } from '../src/type-handle.js';
import type {
  ContentOf,
  ReadonlyTypeSchema,
  StoredContentOf,
  UnlistedValue,
} from '../src/type-handle.js';
import { StackBadRequestError, StackMigrationError } from '../src/errors.js';
import type { DeclaredFields, MigrationBuilder } from '../src/migration-fields.js';
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

const handle = <const S extends ReadonlyTypeSchema>(
  version: number,
  schema: S,
  migratesFrom?: TypeId,
) =>
  typeHandle({
    id: `com.example/x@${version}`,
    name: 'X',
    schema,
    ...(migratesFrom && { migratesFrom }),
  });

describe('migration()', () => {
  test('builds migrate() from its fields, carrying every field none names', () => {
    const m = migration(BookV1, Book, ({ fields, field }) =>
      fields({ status: field('status', { done: 'finished' }) }),
    );
    expect(m.from).toBe(BookV1.id);
    expect(m.to).toBe(Book.id);
    expect(m.migrate({ title: 'Dune', status: 'done' })).toEqual({
      title: 'Dune',
      status: 'finished',
    });
  });

  test('carries a value the source handle does not list through a map', () => {
    const m = migration(BookV1, Book, ({ fields, field }) =>
      fields({ status: field('status', { done: 'finished' }) }),
    );
    expect(m.migrate({ title: 'Dune', status: 'paused' })).toEqual({
      title: 'Dune',
      status: 'paused',
    });
  });

  test('reads every origin from the record as stored', () => {
    const V1 = handle(1, {
      author: { kind: 'string', required: true },
      tags: { kind: 'array', items: { kind: 'enum', values: ['a', 'b'] } },
      archived: { kind: 'boolean' },
    });
    const V2 = handle(
      2,
      {
        by: { kind: 'string', required: true },
        tags: { kind: 'array', items: { kind: 'enum', values: ['x', 'b'] } },
        priority: { kind: 'enum', values: ['low', 'normal'], required: true },
        initial: { kind: 'string' },
      },
      V1.id,
    );
    const m = migration(V1, V2, ({ fields, field, constant, drop, derive }) =>
      fields({
        by: field('author'),
        tags: field('tags', { a: 'x' }),
        priority: constant('normal'),
        archived: drop(),
        initial: derive((c) => c.author.slice(0, 1) || undefined),
      }),
    );
    expect(m.migrate({ author: 'Ada', tags: ['a', 'b'], archived: true })).toEqual({
      by: 'Ada',
      tags: ['x', 'b'],
      priority: 'normal',
      initial: 'A',
    });
    expect(m.migrate({ author: '' })).toEqual({ by: '', priority: 'normal' });
  });

  test('swaps two fields, since no origin sees another', () => {
    const V1 = handle(1, { a: { kind: 'string' }, b: { kind: 'string' } });
    const V2 = handle(2, V1.schema, V1.id);
    const m = migration(V1, V2, ({ fields, field }) => fields({ a: field('b'), b: field('a') }));
    expect(m.migrate({ a: 'x', b: 'y' })).toEqual({ a: 'y', b: 'x' });
    expect(m.migrate({ a: 'x' })).toEqual({ b: 'x' });
  });

  test('types derive() on the source content as stored', () => {
    migration(BookV1, Book, ({ fields, derive }) =>
      fields({
        status: derive((c) => {
          expectTypeOf(c).toEqualTypeOf<StoredContentOf<typeof BookV1.schema>>();
          return c.status === 'done' ? 'finished' : 'want';
        }),
      }),
    );
  });

  test('refuses a target in the same family that does not migrate from the source', () => {
    const BookV3 = typeHandle({
      id: 'com.example.reading/book@3',
      name: 'Book',
      schema: Book.schema,
      migratesFrom: Book,
    });
    expect(() => migration(BookV1, BookV3, ({ fields }) => fields({}))).toThrow(
      `Cannot migrate "${BookV1.id}" to "${BookV3.id}": "${BookV3.id}" migrates from "${Book.id}".`,
    );
    expect(() => migration(Book, BookV1, ({ fields }) => fields({}))).toThrow(StackMigrationError);
  });

  test('builds a migration into another family without lineage', () => {
    const m = migration(Shelf, Book, ({ fields, field, constant }) =>
      fields({ title: field('name'), status: constant('want') }),
    );
    expect(m.migrate({ name: 'Fiction' })).toEqual({ title: 'Fiction', status: 'want' });
  });

  describe('checks its fields against both schemas', () => {
    const V1 = handle(1, {
      title: { kind: 'string', required: true },
      status: { kind: 'enum', values: ['open', 'done'] },
      count: { kind: 'number' },
      meta: { kind: 'object', properties: { a: { kind: 'string' } } },
    });
    const at = (schema: ReadonlyTypeSchema) => handle(2, schema, V1.id);
    // Untyped fields, as a caller the compiler cannot see would write them:
    // these pin the checks migration() makes at runtime.
    type Declare = (
      builder: MigrationBuilder<Record<string, unknown>, Record<string, unknown>>,
    ) => DeclaredFields;
    const refused = (to: ReturnType<typeof at>, declare: Declare, message: string) =>
      expect(() => migration(V1, to, declare as never)).toThrow(
        `Cannot migrate "${V1.id}" to "${to.id}": ${message}.`,
      );
    const same = at(V1.schema);
    const { count: _count, ...withoutCount } = V1.schema;

    test('a name neither Type declares', () => {
      refused(
        same,
        ({ fields, drop }) => fields({ nope: drop() }),
        '"nope": drop(): "nope" is a field of neither Type',
      );
    });

    test('a field the target does not declare, unless it is dropped or read', () => {
      refused(
        at(withoutCount),
        ({ fields }) => fields({}),
        'the target does not declare "count"; drop() it, or read it with field()',
      );
      refused(
        at(withoutCount),
        ({ fields, constant }) => fields({ count: constant(1) }),
        '"count": constant(…): the target does not declare "count", so it can only be dropped',
      );
      expect(() =>
        migration(V1, at(withoutCount), ({ fields, drop }) => fields({ count: drop() })),
      ).not.toThrow();
      expect(() =>
        migration(V1, at({ ...withoutCount, total: { kind: 'number' } }), ({ fields, field }) =>
          fields({ total: field('count') }),
        ),
      ).not.toThrow();
    });

    test('a field origin reading a field the source does not declare', () => {
      refused(
        same,
        ({ fields, field }) => fields({ title: field('nope') }),
        '"title": field("nope"): "nope" is not a field of the source',
      );
    });

    test('a required field nothing produces', () => {
      refused(
        at({ ...V1.schema, due: { kind: 'date', required: true } }),
        ({ fields }) => fields({}),
        '"due" is required at the target, and nothing produces it',
      );
    });

    test('a carried field the target would refuse', () => {
      refused(
        at({ ...V1.schema, count: { kind: 'string' } }),
        ({ fields }) => fields({}),
        '"count" changes kind from number to string',
      );
      refused(
        at({ ...V1.schema, count: { kind: 'number', required: true } }),
        ({ fields }) => fields({}),
        '"count" is optional at the source and required at the target',
      );
      refused(
        at({ ...V1.schema, status: { kind: 'enum', values: ['open', 'finished'] } }),
        ({ fields }) => fields({}),
        '"status" holds "done", which the target\'s enum does not list',
      );
      refused(
        at({ ...V1.schema, status: { kind: 'enum', values: ['open'] } }),
        ({ fields, field }) => fields({ status: field('status', { done: 'closed' }) }),
        '"status" holds "done" (mapped to "closed"), which the target\'s enum does not list',
      );
      refused(
        at({ ...withoutCount, total: { kind: 'string' } }),
        ({ fields, field }) => fields({ total: field('count') }),
        '"total" changes kind from number to string',
      );
      refused(
        at({ ...V1.schema, meta: { kind: 'object', properties: {} } }),
        ({ fields }) => fields({}),
        '"meta.a" is not declared at the target',
      );
    });

    test('a map of a field that holds no strings', () => {
      refused(
        same,
        ({ fields, field }) => fields({ count: field('count', { a: 'b' }) }),
        '"count": field("count", …): only an enum, string or text field, or an array of one, can be mapped',
      );
    });

    test('a constant, or no value, that the target refuses', () => {
      refused(
        at({ ...V1.schema, priority: { kind: 'number' } }),
        ({ fields, constant }) => fields({ priority: constant('high') }),
        '"priority" is set to a value the target refuses: Expected number, got string',
      );
      refused(
        same,
        ({ fields, drop }) => fields({ title: drop() }),
        '"title" is set to a value the target refuses: Required field is missing',
      );
    });

    test('accepts a widening it can carry', () => {
      expect(() =>
        migration(
          V1,
          at({ ...V1.schema, status: { kind: 'string' }, title: { kind: 'text', required: true } }),
          ({ fields }) => fields({}),
        ),
      ).not.toThrow();
      expect(() =>
        migration(
          V1,
          at({ ...V1.schema, status: { kind: 'enum', values: ['open', 'closed'] } }),
          ({ fields, field }) => fields({ status: field('status', { done: 'closed' }) }),
        ),
      ).not.toThrow();
    });
  });
});

describe('defineType()', () => {
  test('accepts a handle as it is', async () => {
    const stack = await Stack.open(await MemoryAdapter.open({ ownerEntityId: OWNER }));
    const type = await stack.defineType(Book);
    expect(type.id).toBe(Book.id);
    expect(type.schema).toEqual(Book.schema);
  });
});
