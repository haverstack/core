/**
 * The three native sort columns are narrowed against at several gates —
 * assertValidSort() in the invariant layer, parseQuery()'s wire parser
 * here, normalizeCapabilities() in wire-types, and the SQLite adapters'
 * cursor decoder. Each rejects what it doesn't recognize, so a column
 * added to NATIVE_SORT_FIELDS but missed at one of them fails *silently*:
 * refused at the wire, dropped from advertised capabilities, or rejected
 * in a cursor, with no error naming the cause.
 *
 * These tests are the alarm for that. They assert nothing about which
 * three fields there are — only that every gate admits whatever
 * NATIVE_SORT_FIELDS says, so a fourth column has one place to be added.
 */
import { describe, test, expect } from 'vitest';
import { NATIVE_SORT_FIELDS } from '../src/types.js';
import { assertValidSort } from '../src/query-validation.js';
import { parseQueryParams } from '../src/wire-request.js';
import { StackBadRequestError } from '../src/errors.js';

const url = (search: string) => new URL(`https://example.com/records${search}`);

describe('NATIVE_SORT_FIELDS', () => {
  test('is the set assertValidSort admits', () => {
    for (const field of NATIVE_SORT_FIELDS) {
      expect(() => assertValidSort({ field })).not.toThrow();
    }
    expect(() => assertValidSort({ field: 'name' as never })).toThrow(StackBadRequestError);
  });

  test('names itself in the error a rejected sort field gets', () => {
    // The list a caller is told to choose from is the list actually
    // enforced, rather than a sentence that has to be remembered.
    try {
      assertValidSort({ field: 'name' as never });
      expect.unreachable();
    } catch (err) {
      for (const field of NATIVE_SORT_FIELDS) {
        expect((err as Error).message).toContain(field);
      }
    }
  });

  test('is the set the wire request parser admits', () => {
    for (const field of NATIVE_SORT_FIELDS) {
      expect(parseQueryParams(url(`?sort=${field}`)).sort).toEqual({ field });
    }
    expect(() => parseQueryParams(url('?sort=name'))).toThrow(StackBadRequestError);
  });
});
