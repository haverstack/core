import { describe, test, expect } from 'vitest';
import {
  parseQueryParams,
  parseQueryBody,
  parseChangeParams,
  parseIfMatch,
  parseUploadFilename,
  parsePositiveInt,
  parseDate,
} from '../src/wire-entry.js';
import { StackQueryError } from '../src/stack.js';

const url = (qs: string): URL => new URL(`https://stack.example.com/records${qs}`);
const changes = (qs: string): URL => new URL(`https://stack.example.com/changes${qs}`);

// -------------------------------------------------------
// GET /records
// -------------------------------------------------------

describe('parseQueryParams', () => {
  test('an empty query string parses to an empty query, not an empty filter', () => {
    expect(parseQueryParams(url(''))).toEqual({});
  });

  test('a repeated param collapses to a scalar at one value and an array beyond', () => {
    expect(parseQueryParams(url('?typeId=a')).filter?.typeId).toBe('a');
    expect(parseQueryParams(url('?typeId=a&typeId=b')).filter?.typeId).toEqual(['a', 'b']);
  });

  test('parentId="null" is the top-level sentinel, distinct from an unset parentId', () => {
    expect(parseQueryParams(url('?parentId=null')).filter?.parentId).toBeNull();
    expect(parseQueryParams(url('?parentId=rec-1')).filter?.parentId).toBe('rec-1');
    expect(parseQueryParams(url('')).filter).toBeUndefined();
  });

  test('includeDeleted and includeUnlisted are set only by the literal "true"', () => {
    expect(parseQueryParams(url('?includeDeleted=true')).filter?.includeDeleted).toBe(true);
    expect(parseQueryParams(url('?includeDeleted=1')).filter?.includeDeleted).toBeUndefined();
    expect(parseQueryParams(url('?includeUnlisted=true')).filter?.includeUnlisted).toBe(true);
    expect(parseQueryParams(url('?includeUnlisted=yes')).filter?.includeUnlisted).toBeUndefined();
  });

  test('a malformed date bound is refused rather than dropped', () => {
    expect(() => parseQueryParams(url('?createdBefore=not-a-date'))).toThrow(StackQueryError);
  });

  test('an unrecognized sort field or direction is refused', () => {
    expect(() => parseQueryParams(url('?sort=name'))).toThrow(StackQueryError);
    expect(() => parseQueryParams(url('?sort=createdAt&direction=sideways'))).toThrow(
      StackQueryError,
    );
  });

  test('a non-integer limit is refused rather than coerced', () => {
    expect(() => parseQueryParams(url('?limit=2.7'))).toThrow(StackQueryError);
    expect(() => parseQueryParams(url('?limit=-5'))).toThrow(StackQueryError);
    expect(() => parseQueryParams(url('?limit=10abc'))).toThrow(StackQueryError);
  });

  // A ceiling is deployment policy rather than wire contract, so the
  // requested limit is reported as asked and the server caps it itself.
  test('a large limit is reported as requested, not clamped', () => {
    expect(parseQueryParams(url('?limit=5000')).limit).toBe(5000);
  });

  describe('relatedTo', () => {
    test('the three target scopes are mutually exclusive', () => {
      expect(() => parseQueryParams(url('?relatedTo=r1&relatedToEntity=did:key:z'))).toThrow(
        StackQueryError,
      );
      expect(() => parseQueryParams(url('?relatedToEntity=did:key:z&relatedToNs=isbn'))).toThrow(
        StackQueryError,
      );
    });

    test('a qualifier without the param it qualifies is refused', () => {
      expect(() => parseQueryParams(url('?relatedToStack=https://x.example'))).toThrow(
        StackQueryError,
      );
      expect(() => parseQueryParams(url('?relatedToId=978'))).toThrow(StackQueryError);
    });

    // An omitted relatedToStack matches only local targets; an empty one is
    // neither that nor a wildcard, and reaches core's validation as the
    // empty string it is rather than as an absent field.
    test('an empty qualifier passes through raw rather than as absent', () => {
      const target = parseQueryParams(url('?relatedTo=r1&relatedToStack=')).filter?.relatedTo
        ?.target;
      expect(target).toEqual({ scope: 'record', recordId: 'r1', stackUrl: '' });

      const external = parseQueryParams(url('?relatedToNs=isbn&relatedToId=')).filter?.relatedTo
        ?.target;
      expect(external).toEqual({ scope: 'external', ns: 'isbn', id: '' });
    });

    test('a label alone is a valid filter', () => {
      expect(parseQueryParams(url('?relatedToLabel=cites')).filter?.relatedTo).toEqual({
        label: 'cites',
      });
    });
  });
});

// -------------------------------------------------------
// POST /records/query
// -------------------------------------------------------

describe('parseQueryBody', () => {
  test('a non-object body parses to an empty query', () => {
    expect(parseQueryBody(undefined)).toEqual({});
    expect(parseQueryBody(null)).toEqual({});
    expect(parseQueryBody('nonsense')).toEqual({});
  });

  test('ISO date strings decode back to Date objects', () => {
    const parsed = parseQueryBody({
      filter: { createdAt: { before: '2024-06-15T12:00:00.000Z' } },
    });
    expect(parsed.filter?.createdAt?.before).toBeInstanceOf(Date);
    expect(parsed.filter?.createdAt?.before?.toISOString()).toBe('2024-06-15T12:00:00.000Z');
  });

  test('a wrongly typed filter field is refused rather than coerced', () => {
    expect(() => parseQueryBody({ filter: { typeId: 42 } })).toThrow(StackQueryError);
    expect(() => parseQueryBody({ filter: { tags: 'starred' } })).toThrow(StackQueryError);
    expect(() => parseQueryBody({ filter: { content: ['a'] } })).toThrow(StackQueryError);
    expect(() => parseQueryBody({ filter: [] })).toThrow(StackQueryError);
  });

  test('a non-integer limit is refused rather than coerced', () => {
    expect(() => parseQueryBody({ limit: 2.7 })).toThrow(StackQueryError);
    expect(() => parseQueryBody({ limit: 0 })).toThrow(StackQueryError);
    expect(() => parseQueryBody({ limit: '10' })).toThrow(StackQueryError);
  });

  test('a large limit is reported as requested, not clamped', () => {
    expect(parseQueryBody({ limit: 5000 }).limit).toBe(5000);
  });

  test('an unrecognized relatedTo target scope is refused', () => {
    expect(() =>
      parseQueryBody({ filter: { relatedTo: { target: { scope: 'galaxy' } } } }),
    ).toThrow(StackQueryError);
  });

  test('filter.content carries multi-segment keys through untouched', () => {
    expect(parseQueryBody({ filter: { content: { 'emails.value': 'a@example.com' } } })).toEqual({
      filter: { content: { 'emails.value': 'a@example.com' } },
    });
  });
});

// -------------------------------------------------------
// Fields with no wire encoding
// -------------------------------------------------------

// Dropping either would answer with a result set the caller believes is
// narrower (baseId) or migrated (presentAt) than what it holds — the
// silent degradation a capability-gated filter is already refused for.
describe('fields that never travel', () => {
  test('baseId is refused on both query surfaces', () => {
    expect(() => parseQueryParams(url('?baseId=com.example/note'))).toThrow(StackQueryError);
    expect(() => parseQueryBody({ filter: { baseId: 'com.example/note' } })).toThrow(
      StackQueryError,
    );
  });

  test('presentAt is refused on both query surfaces', () => {
    expect(() => parseQueryParams(url('?presentAt=latest'))).toThrow(StackQueryError);
    expect(() => parseQueryBody({ presentAt: 'latest' })).toThrow(StackQueryError);
  });

  // Judged by key, not by value: "stored" is presentAt's default and asks
  // for nothing, but a client sending it still believes the field means
  // something over the wire, and it does not.
  test('presentAt is refused by presence, whatever its value', () => {
    expect(() => parseQueryBody({ presentAt: 'stored' })).toThrow(StackQueryError);
    expect(() => parseQueryBody({ filter: { baseId: undefined } })).toThrow(StackQueryError);
  });

  test('the refusal names what to send instead', () => {
    expect(() => parseQueryBody({ filter: { baseId: 'x' } })).toThrow(/typeId/);
    expect(() => parseQueryBody({ presentAt: 'latest' })).toThrow(/client-side/);
  });
});

// -------------------------------------------------------
// GET /changes
// -------------------------------------------------------

describe('parseChangeParams', () => {
  test('no params yields an empty filter with both flags off', () => {
    expect(parseChangeParams(changes(''))).toEqual({
      filter: {},
      includeRecords: false,
      includeUnlisted: false,
    });
  });

  test('parentId="null" is the top-level sentinel, as on GET /records', () => {
    expect(parseChangeParams(changes('?parentId=null')).filter.parentId).toBeNull();
    expect(parseChangeParams(changes('?parentId=rec-1')).filter.parentId).toBe('rec-1');
  });

  test('an unrecognized kind is refused rather than dropped from the set', () => {
    expect(() => parseChangeParams(changes('?kind=created&kind=exploded'))).toThrow(
      StackQueryError,
    );
  });

  test('include accepts only "record"', () => {
    expect(parseChangeParams(changes('?include=record')).includeRecords).toBe(true);
    expect(() => parseChangeParams(changes('?include=everything'))).toThrow(StackQueryError);
  });

  test('includeUnlisted is set only by the literal "true"', () => {
    expect(parseChangeParams(changes('?includeUnlisted=true')).includeUnlisted).toBe(true);
    expect(parseChangeParams(changes('?includeUnlisted=1')).includeUnlisted).toBe(false);
  });
});

// -------------------------------------------------------
// Headers
// -------------------------------------------------------

describe('parseIfMatch', () => {
  test('an absent header leaves the mutation unconditional', () => {
    expect(parseIfMatch(undefined)).toBeUndefined();
  });

  test('a quoted or bare version parses to the number', () => {
    expect(parseIfMatch('"5"')).toBe(5);
    expect(parseIfMatch('5')).toBe(5);
    expect(parseIfMatch('  "12"  ')).toBe(12);
  });

  // The header exists to fence a write, so reading a malformed one as
  // absent would turn the fence into the unconditional last-writer-wins
  // mutation it was sent to prevent.
  test('a malformed value is refused rather than read as absent', () => {
    expect(() => parseIfMatch('"abc"')).toThrow(StackQueryError);
    expect(() => parseIfMatch('"5abc"')).toThrow(StackQueryError);
    expect(() => parseIfMatch('')).toThrow(StackQueryError);
    expect(() => parseIfMatch('*')).toThrow(StackQueryError);
  });

  // A version match is exact or it is nothing, so the weak comparator has
  // no meaning here and is not quietly read as its strong form.
  test('a weak comparator is refused', () => {
    expect(() => parseIfMatch('W/"5"')).toThrow(StackQueryError);
  });
});

describe('parseUploadFilename', () => {
  test('an absent header yields no filename', () => {
    expect(parseUploadFilename(undefined)).toBeUndefined();
  });

  test('the RFC 5987 extended form wins over the plain one', () => {
    expect(
      parseUploadFilename(`attachment; filename="fallback.txt"; filename*=UTF-8''caf%C3%A9.txt`),
    ).toBe('café.txt');
  });

  test('the plain quoted form is the fallback', () => {
    expect(parseUploadFilename('attachment; filename="report.pdf"')).toBe('report.pdf');
  });

  test('malformed percent-encoding falls back rather than throwing', () => {
    expect(parseUploadFilename(`attachment; filename="ok.txt"; filename*=UTF-8''%E0%A4%A`)).toBe(
      'ok.txt',
    );
  });

  test('a header naming no filename yields none', () => {
    expect(parseUploadFilename('attachment')).toBeUndefined();
  });
});

// -------------------------------------------------------
// Shared primitives
// -------------------------------------------------------

describe('parsePositiveInt', () => {
  test('accepts a bare positive integer and refuses anything else', () => {
    expect(parsePositiveInt('7', 'version')).toBe(7);
    expect(parsePositiveInt('0', 'version')).toBe(0);
    for (const bad of ['-1', '1.5', '1abc', '', ' 1', '1e3']) {
      expect(() => parsePositiveInt(bad, 'version')).toThrow(StackQueryError);
    }
  });
});

describe('parseDate', () => {
  test('decodes an ISO string and reports anything else as undefined', () => {
    expect(parseDate('2024-06-15T12:00:00.000Z')?.toISOString()).toBe('2024-06-15T12:00:00.000Z');
    expect(parseDate('not-a-date')).toBeUndefined();
    expect(parseDate(1718452800000)).toBeUndefined();
    expect(parseDate(undefined)).toBeUndefined();
  });
});
