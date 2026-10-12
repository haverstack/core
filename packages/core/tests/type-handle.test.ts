import { describe, test, expect, expectTypeOf } from 'vitest';
import { Stack } from '../src/stack/stack.js';
import { MemoryAdapter } from '../src/testing.js';
import { migration, typeHandle } from '../src/type-handle.js';
import { add, derive, drop, map, rename } from '../src/migration-steps.js';
import type {
  ContentOf,
  ReadonlyTypeSchema,
  StoredContentOf,
  UnlistedValue,
} from '../src/type-handle.js';
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
  test('builds migrate() from its steps, carrying every field no step names', () => {
    const m = migration(BookV1, Book, [map('status', { done: 'finished' })]);
    expect(m.from).toBe(BookV1.id);
    expect(m.to).toBe(Book.id);
    expect(m.steps).toHaveLength(1);
    expect(m.migrate({ title: 'Dune', status: 'done' })).toEqual({
      title: 'Dune',
      status: 'finished',
    });
  });

  test('carries a value the source handle does not list through map()', () => {
    const m = migration(BookV1, Book, [map('status', { done: 'finished' })]);
    expect(m.migrate({ title: 'Dune', status: 'paused' })).toEqual({
      title: 'Dune',
      status: 'paused',
    });
  });

  test('applies steps in order, each to what the last left', () => {
    const V1 = handle(1, {
      author: { kind: 'string', required: true },
      tags: { kind: 'array', items: { kind: 'enum', values: ['a', 'b'] } },
      legacy: { kind: 'boolean' },
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
    const m = migration(V1, V2, [
      rename('author', 'by'),
      map('tags', { a: 'x' }),
      add('priority', 'normal'),
      drop('legacy'),
      derive('initial', (c) => c.author.slice(0, 1) || undefined),
    ]);
    expect(m.migrate({ author: 'Ada', tags: ['a', 'b'], legacy: true })).toEqual({
      by: 'Ada',
      tags: ['x', 'b'],
      priority: 'normal',
      initial: 'A',
    });
    expect(m.migrate({ author: '' })).toEqual({ by: '', priority: 'normal' });
  });

  test('types derive() on the source content as stored', () => {
    migration(BookV1, Book, [
      derive('status', (c) => {
        expectTypeOf(c).toEqualTypeOf<StoredContentOf<typeof BookV1.schema>>();
        return c.status === 'done' ? 'finished' : c.status;
      }),
    ]);
    // Never run: the check is the compiler's.
    void (() =>
      // @ts-expect-error the source declares no `isbn`
      migration(BookV1, Book, [derive('pages', (c) => c.isbn)]));
  });

  test('refuses a target in the same family that does not migrate from the source', () => {
    const BookV3 = typeHandle({
      id: 'com.example.reading/book@3',
      name: 'Book',
      schema: Book.schema,
      migratesFrom: Book,
    });
    expect(() => migration(BookV1, BookV3, [])).toThrow(
      `Cannot migrate "${BookV1.id}" to "${BookV3.id}": "${BookV3.id}" migrates from "${Book.id}".`,
    );
    expect(() => migration(Book, BookV1, [])).toThrow(StackMigrationError);
  });

  test('builds a step into another family without lineage', () => {
    const m = migration(Shelf, Book, [rename('name', 'title'), add('status', 'want')]);
    expect(m.migrate({ name: 'Fiction' })).toEqual({ title: 'Fiction', status: 'want' });
  });

  describe('checks its steps against both schemas', () => {
    const V1 = handle(1, {
      title: { kind: 'string', required: true },
      status: { kind: 'enum', values: ['open', 'done'] },
      count: { kind: 'number' },
      meta: { kind: 'object', properties: { a: { kind: 'string' } } },
    });
    const at = (schema: ReadonlyTypeSchema) => handle(2, schema, V1.id);
    const refused = (
      to: ReturnType<typeof at>,
      steps: Parameters<typeof migration<typeof V1.schema, ReadonlyTypeSchema>>[2],
      message: string,
    ) =>
      expect(() => migration(V1, to, steps)).toThrow(
        `Cannot migrate "${V1.id}" to "${to.id}": ${message}.`,
      );
    const same = at(V1.schema);

    test('a step naming a field that is not there', () => {
      refused(
        same,
        [rename('nope', 'title')],
        'rename("nope", "title"): "nope" is not a field at this point',
      );
      refused(
        same,
        [drop('title'), drop('title')],
        'drop("title"): "title" is not a field at this point',
      );
      refused(same, [map('nope', {})], 'map("nope", …): "nope" is not a field at this point');
    });

    test('a step onto a field that is already there', () => {
      refused(
        same,
        [rename('title', 'count')],
        'rename("title", "count"): "count" is already a field at this point',
      );
      refused(
        same,
        [add('title', 'x')],
        'add("title", …): "title" is already a field at this point',
      );
    });

    test('a field the target does not declare', () => {
      const { count: _count, ...rest } = V1.schema;
      refused(
        at(rest),
        [],
        '"count" is carried to a Type that does not declare it; drop or rename it',
      );
      refused(
        at(V1.schema),
        [derive('extra', () => 1)],
        '"extra" is carried to a Type that does not declare it; drop or rename it',
      );
    });

    test('a required field nothing produces', () => {
      refused(
        at({ ...V1.schema, due: { kind: 'date', required: true } }),
        [],
        '"due" is required at the target, and no step produces it',
      );
    });

    test('a carried field the target would refuse', () => {
      refused(
        at({ ...V1.schema, count: { kind: 'string' } }),
        [],
        '"count" changes kind from number to string',
      );
      refused(
        at({ ...V1.schema, count: { kind: 'number', required: true } }),
        [],
        '"count" is optional at the source and required at the target',
      );
      refused(
        at({ ...V1.schema, status: { kind: 'enum', values: ['open', 'finished'] } }),
        [],
        '"status" holds "done", which the target\'s enum does not list',
      );
      refused(
        at({ ...V1.schema, status: { kind: 'enum', values: ['open'] } }),
        [map('status', { done: 'closed' })],
        '"status" holds "done" (mapped to "closed"), which the target\'s enum does not list',
      );
      refused(
        at({ ...V1.schema, meta: { kind: 'object', properties: {} } }),
        [],
        '"meta.a" is not declared at the target',
      );
    });

    test('a map of a field that holds no strings', () => {
      refused(
        same,
        [map('count', { a: 'b' })],
        'map("count", …): only an enum, string or text field, or an array of one, can be mapped',
      );
    });

    test('an added value the target refuses', () => {
      refused(
        at({ ...V1.schema, priority: { kind: 'number' } }),
        [add('priority', 'high')],
        '"priority" is set to a value the target refuses: Expected number, got string',
      );
    });

    test('accepts a widening it can carry', () => {
      expect(() =>
        migration(
          V1,
          at({ ...V1.schema, status: { kind: 'string' }, title: { kind: 'text', required: true } }),
          [],
        ),
      ).not.toThrow();
      expect(() =>
        migration(V1, at({ ...V1.schema, status: { kind: 'enum', values: ['open', 'closed'] } }), [
          map('status', { done: 'closed' }),
        ]),
      ).not.toThrow();
    });
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
