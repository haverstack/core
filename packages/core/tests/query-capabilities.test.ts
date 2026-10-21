/**
 * A capability refusal names the capability it was refused for, on the
 * error itself. A client reporting the refusal in its own vocabulary —
 * `adapter-api` turns it into APIAdapterCapabilityError — reads that name
 * rather than re-deriving it from the query, so there is one answer to
 * which capability a query needed instead of two that can disagree.
 *
 * The malformed-path cases carry no name: a path no adapter could address
 * is the caller's error at every capability level, and naming one would
 * send a caller to look at a discovery entry that is not the problem.
 */
import { describe, test, expect } from 'vitest';
import {
  assertQueryCapabilities,
  assertSortCapability,
  assertValidContentByType,
  assertValidSort,
} from '../src/query-validation.js';
import { StackBadRequestError } from '../src/errors.js';
import type {
  MissingCapability,
  QuerySort,
  RecordFilter,
  StackCapabilities,
} from '../src/types/index.js';

const ALL: StackCapabilities = {
  filter: { content: 'path', contentPresent: true, contentByType: 64, search: true },
  sort: {
    fields: ['createdAt', 'updatedAt', 'version'],
    contentField: true,
    contentFieldByType: 64,
  },
  limits: { attachmentBytes: null, contentBytes: null },
};

const without = (overrides: {
  filter?: Partial<StackCapabilities['filter']>;
  sort?: Partial<StackCapabilities['sort']>;
}): StackCapabilities => ({
  ...ALL,
  filter: { ...ALL.filter, ...overrides.filter },
  sort: { ...ALL.sort, ...overrides.sort },
});

/** The capability a refusal named, or undefined when it named none. */
const refusalFor = (run: () => void): MissingCapability | undefined => {
  try {
    run();
  } catch (err) {
    expect(err).toBeInstanceOf(StackBadRequestError);
    return (err as StackBadRequestError).capability;
  }
  throw new Error('expected a refusal');
};

describe('a refused query names the capability it needed', () => {
  test('filter.search', () => {
    expect(
      refusalFor(() =>
        assertQueryCapabilities({ search: 'hello' }, without({ filter: { search: false } })),
      ),
    ).toBe('filter.search');
  });

  // The reach is what is absent whichever key asked for it, so both name
  // the discovery entry to look at rather than the key that was used.
  test.each([
    ['filter.content', { content: { slug: 'x' } }],
    ['filter.contentPresent', { contentPresent: ['slug'] }],
  ] as [string, RecordFilter][])("reach 'none', asked for by %s", (_label, filter) => {
    expect(
      refusalFor(() => assertQueryCapabilities(filter, without({ filter: { content: 'none' } }))),
    ).toBe('filter.content');
  });

  test('filter.contentPresent against a reach that serves content', () => {
    expect(
      refusalFor(() =>
        assertQueryCapabilities(
          { contentPresent: ['slug'] },
          without({ filter: { contentPresent: false } }),
        ),
      ),
    ).toBe('filter.contentPresent');
  });

  test("a nested path against reach 'field'", () => {
    expect(
      refusalFor(() =>
        assertQueryCapabilities(
          { content: { 'emails.value': 'a@b.c' } },
          without({ filter: { content: 'field' } }),
        ),
      ),
    ).toBe('filter.content');
  });

  test('sort.contentField', () => {
    expect(
      refusalFor(() =>
        assertSortCapability({ contentField: 'slug' }, without({ sort: { contentField: false } })),
      ),
    ).toBe('sort.contentField');
  });

  const ARMS: RecordFilter = {
    contentByType: { 'com.example/x@1': { content: { a: 1 } }, 'com.example/x@2': {} },
  };

  test('filter.contentByType declined', () => {
    expect(
      refusalFor(() => assertQueryCapabilities(ARMS, without({ filter: { contentByType: 0 } }))),
    ).toBe('filter.contentByType');
  });

  test('filter.contentByType past its cap', () => {
    expect(
      refusalFor(() => assertQueryCapabilities(ARMS, without({ filter: { contentByType: 1 } }))),
    ).toBe('filter.contentByType');
    expect(() =>
      assertQueryCapabilities(ARMS, without({ filter: { contentByType: 2 } })),
    ).not.toThrow();
  });

  test("filter.contentByType against reach 'none'", () => {
    expect(
      refusalFor(() => assertQueryCapabilities(ARMS, without({ filter: { content: 'none' } }))),
    ).toBe('filter.content');
  });

  test("an arm's keys are gated as top-level keys are", () => {
    const arm = (predicate: object): RecordFilter => ({
      contentByType: { 'com.example/x@1': predicate },
    });
    expect(
      refusalFor(() =>
        assertQueryCapabilities(
          arm({ content: { 'a.b': 1 } }),
          without({ filter: { content: 'field' } }),
        ),
      ),
    ).toBe('filter.content');
    expect(
      refusalFor(() =>
        assertQueryCapabilities(
          arm({ contentPresent: ['a'] }),
          without({ filter: { contentPresent: false } }),
        ),
      ),
    ).toBe('filter.contentPresent');
  });

  test('sort.contentFieldByType declined, or past its cap', () => {
    const sort = { contentFieldByType: { 'com.example/x@1': { field: 'a' } } };
    expect(
      refusalFor(() => assertSortCapability(sort, without({ sort: { contentFieldByType: 0 } }))),
    ).toBe('sort.contentFieldByType');
    expect(() =>
      assertSortCapability(sort, without({ sort: { contentFieldByType: 1 } })),
    ).not.toThrow();
  });

  test('a null per-Type cap admits any number of keys', () => {
    const typeIds = Array.from({ length: 500 }, (_, i) => `com.example/x@${i + 1}`);
    const filter = { contentByType: Object.fromEntries(typeIds.map((id) => [id, {}])) };
    const sort = {
      contentFieldByType: Object.fromEntries(typeIds.map((id) => [id, { field: 'a' }])),
    };
    const unbounded = without({
      filter: { contentByType: null },
      sort: { contentFieldByType: null },
    });
    expect(() => assertQueryCapabilities(filter, unbounded)).not.toThrow();
    expect(() => assertSortCapability(sort, unbounded)).not.toThrow();
  });

  test('sort.fields', () => {
    expect(
      refusalFor(() =>
        assertSortCapability({ field: 'version' }, without({ sort: { fields: [] } })),
      ),
    ).toBe('sort.fields');
  });
});

describe('a query refused for its own shape names no capability', () => {
  test.each([
    ["reach 'path'", 'path'],
    ["reach 'field'", 'field'],
  ] as const)('a malformed content path at %s', (_label, content) => {
    expect(
      refusalFor(() =>
        assertQueryCapabilities({ content: { 'a..b': 1 } }, without({ filter: { content } })),
      ),
    ).toBeUndefined();
  });
});

describe('the per-Type shapes are held to a split along Types', () => {
  test.each([
    ['an empty map', { contentByType: {} }],
    ['an arm keyed by something other than a TypeId', { contentByType: { note: {} } }],
    ['an arm carrying another key', { contentByType: { 'com.example/x@1': { typeId: 'y' } } }],
    ['an arm that is not an object', { contentByType: { 'com.example/x@1': [] } }],
    [
      'arms beside a top-level content filter',
      { content: { a: 1 }, contentByType: { 'com.example/x@1': {} } },
    ],
    [
      'arms beside a top-level presence filter',
      { contentPresent: ['a'], contentByType: { 'com.example/x@1': {} } },
    ],
    [
      'a malformed path in an arm',
      { contentByType: { 'com.example/x@1': { content: { 'a..b': 1 } } } },
    ],
  ])('filter.contentByType refuses %s', (_label, filter) => {
    expect(refusalFor(() => assertValidContentByType(filter as RecordFilter))).toBeUndefined();
  });

  test.each([
    ['an empty map', {}],
    ['a key that is not a TypeId', { note: { field: 'a' } }],
    ['a key naming both a field and a value', { 'com.example/x@1': { field: 'a', value: 1 } }],
    ['a nested field', { 'com.example/x@1': { field: 'a.b' } }],
    ['a value that is not a scalar', { 'com.example/x@1': { value: [] } }],
    ['a value that is not finite', { 'com.example/x@1': { value: Infinity } }],
  ])('sort.contentFieldByType refuses %s', (_label, contentFieldByType) => {
    expect(refusalFor(() => assertValidSort({ contentFieldByType } as QuerySort))).toBeUndefined();
  });

  test('a sort names one member only', () => {
    expect(
      refusalFor(() =>
        assertValidSort({
          contentField: 'a',
          contentFieldByType: { 'com.example/x@1': { field: 'a' } },
        } as unknown as QuerySort),
      ),
    ).toBeUndefined();
  });

  test('accepts a well-formed split', () => {
    expect(() =>
      assertValidContentByType({
        contentByType: {
          'com.example/x@1': { content: { 'a.b': 1 }, contentPresent: ['c'] },
          'com.example/x@2': {},
        },
      }),
    ).not.toThrow();
    expect(() =>
      assertValidSort({
        contentFieldByType: {
          'com.example/x@1': { field: 'a' },
          'com.example/x@2': { value: 3 },
          'com.example/x@3': { value: null },
        },
      }),
    ).not.toThrow();
  });
});
