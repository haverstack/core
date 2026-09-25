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
import { assertQueryCapabilities, assertSortCapability } from '../src/query-validation.js';
import { StackBadRequestError } from '../src/errors.js';
import type { MissingCapability, RecordFilter, StackFeatures } from '../src/types.js';

const ALL: StackFeatures = {
  filter: { content: 'path', contentPresent: true, search: true },
  sort: { fields: ['createdAt', 'updatedAt', 'version'], contentField: true },
  limits: { attachmentBytes: null, contentBytes: null },
};

const without = (overrides: {
  filter?: Partial<StackFeatures['filter']>;
  sort?: Partial<StackFeatures['sort']>;
}): StackFeatures => ({
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
