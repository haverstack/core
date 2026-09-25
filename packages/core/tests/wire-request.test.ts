import { describe, test, expect } from 'vitest';
import {
  parseQueryParams,
  parseQueryBody,
  parseChangeParams,
  parseJournalParams,
  parseIfMatch,
  parseUploadFilename,
  parsePositiveInt,
  parseDate,
  assertQueryTravels,
} from '../src/wire-entry.js';
import { StackBadRequestError } from '../src/errors.js';

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

  test('includeDeleted and includeUnlisted take only "true" or "false"', () => {
    expect(parseQueryParams(url('?includeDeleted=true')).filter?.includeDeleted).toBe(true);
    expect(parseQueryParams(url('?includeDeleted=false')).filter?.includeDeleted).toBeUndefined();
    expect(parseQueryParams(url('?includeUnlisted=true')).filter?.includeUnlisted).toBe(true);
    expect(() => parseQueryParams(url('?includeDeleted=1'))).toThrow(StackBadRequestError);
    expect(() => parseQueryParams(url('?includeUnlisted=yes'))).toThrow(StackBadRequestError);
  });

  test('an unrecognized param is refused rather than ignored', () => {
    expect(() => parseQueryParams(url('?entityId=did:key:x'))).toThrow(/Unknown query param/);
  });

  test('a single-value param appears at most once; a filter list may repeat', () => {
    expect(() => parseQueryParams(url('?includeDeleted=true&includeDeleted=junk'))).toThrow(
      /Repeated query param: includeDeleted/,
    );
    expect(() => parseQueryParams(url('?limit=5&limit=500'))).toThrow(/Repeated query param/);
    expect(parseQueryParams(url('?typeId=a/b@1&typeId=a/c@1&tag=x&tag=y')).filter).toMatchObject({
      typeId: ['a/b@1', 'a/c@1'],
      tags: ['x', 'y'],
    });
  });

  test('a malformed date bound is refused rather than dropped', () => {
    expect(() => parseQueryParams(url('?createdBefore=not-a-date'))).toThrow(StackBadRequestError);
  });

  test('an unrecognized sort field or direction is refused', () => {
    expect(() => parseQueryParams(url('?sort=name'))).toThrow(StackBadRequestError);
    expect(() => parseQueryParams(url('?sort=createdAt&direction=sideways'))).toThrow(
      StackBadRequestError,
    );
  });

  test('?sortContent= names a content field, distinct from the native ?sort=', () => {
    expect(parseQueryParams(url('?sortContent=publishedAt&direction=asc')).sort).toEqual({
      contentField: 'publishedAt',
      direction: 'asc',
    });
    // A content field may be named after a native column; which parameter
    // carries it is what says which was meant.
    expect(parseQueryParams(url('?sortContent=version')).sort).toEqual({
      contentField: 'version',
    });
    expect(parseQueryParams(url('?sort=version')).sort).toEqual({ field: 'version' });
  });

  test('naming both sort parameters is refused rather than resolved', () => {
    expect(() => parseQueryParams(url('?sort=createdAt&sortContent=publishedAt'))).toThrow(
      StackBadRequestError,
    );
  });

  test('a non-integer limit is refused rather than coerced', () => {
    expect(() => parseQueryParams(url('?limit=2.7'))).toThrow(StackBadRequestError);
    expect(() => parseQueryParams(url('?limit=-5'))).toThrow(StackBadRequestError);
    expect(() => parseQueryParams(url('?limit=10abc'))).toThrow(StackBadRequestError);
  });

  // A ceiling is deployment policy rather than wire contract, so the
  // requested limit is reported as asked and the server caps it itself.
  test('a large limit is reported as requested, not clamped', () => {
    expect(parseQueryParams(url('?limit=5000')).limit).toBe(5000);
  });

  describe('relatedTo', () => {
    test('the three target kinds are mutually exclusive', () => {
      expect(() => parseQueryParams(url('?relatedTo=r1&relatedToEntity=did:key:z'))).toThrow(
        StackBadRequestError,
      );
      expect(() => parseQueryParams(url('?relatedToEntity=did:key:z&relatedToNs=isbn'))).toThrow(
        StackBadRequestError,
      );
    });

    test('a qualifier without the param it qualifies is refused', () => {
      expect(() => parseQueryParams(url('?relatedToStack=https://x.example'))).toThrow(
        StackBadRequestError,
      );
      expect(() => parseQueryParams(url('?relatedToId=978'))).toThrow(StackBadRequestError);
    });

    // An omitted relatedToStack matches only local targets; an empty one is
    // neither that nor a wildcard, and reaches core's validation as the
    // empty string it is rather than as an absent field.
    test('an empty qualifier passes through raw rather than as absent', () => {
      const target = parseQueryParams(url('?relatedTo=r1&relatedToStack=')).filter?.relatedTo
        ?.target;
      expect(target).toEqual({ kind: 'record', recordId: 'r1', stackUrl: '' });

      const external = parseQueryParams(url('?relatedToNs=isbn&relatedToId=')).filter?.relatedTo
        ?.target;
      expect(external).toEqual({ kind: 'external', ns: 'isbn', id: '' });
    });

    test('a label alone is a valid filter', () => {
      expect(parseQueryParams(url('?relatedToLabel=cites')).filter?.relatedTo).toEqual({
        label: 'cites',
      });
    });
  });

  describe('attachment', () => {
    test('attachmentLabel and attachmentFileId decode into one filter', () => {
      expect(
        parseQueryParams(url('?attachmentLabel=cover&attachmentFileId=f1')).filter?.attachment,
      ).toEqual({ label: 'cover', fileId: 'f1' });
    });

    test('an empty value passes through raw rather than as absent', () => {
      expect(parseQueryParams(url('?attachmentLabel=')).filter?.attachment).toEqual({ label: '' });
    });

    test('referencesFileId is its own filter, not an attachment half', () => {
      expect(parseQueryParams(url('?referencesFileId=f1')).filter).toEqual({
        referencesFileId: 'f1',
      });
    });
  });
});

// -------------------------------------------------------
// POST /records/query
// -------------------------------------------------------

describe('parseQueryBody', () => {
  test('an absent body is an empty query, and a non-object body is refused', () => {
    expect(parseQueryBody(undefined)).toEqual({});
    expect(() => parseQueryBody(null)).toThrow(StackBadRequestError);
    expect(() => parseQueryBody('nonsense')).toThrow(StackBadRequestError);
  });

  test('an unrecognized key is refused at every level', () => {
    for (const body of [
      { filters: {} },
      { filter: { entityId: 'x' } },
      { filter: { createdBy: { entityId: 'x' } } },
      { filter: { attachment: { label: 'a', mime: 'x' } } },
      { filter: { createdAt: { before: '2024-01-01', on: '2024-01-01' } } },
      { filter: { relatedTo: { label: 'x', scope: 'entity' } } },
      { filter: { relatedTo: { target: { kind: 'entity', entityId: 'e', ns: 'x' } } } },
      { sort: { field: 'createdAt', order: 'asc' } },
    ]) {
      expect(() => parseQueryBody(body), JSON.stringify(body)).toThrow(/Unknown key/);
    }
  });

  test('a non-boolean includeDeleted or a non-string cursor is refused', () => {
    expect(() => parseQueryBody({ filter: { includeDeleted: 'true' } })).toThrow(
      StackBadRequestError,
    );
    expect(() => parseQueryBody({ cursor: 5 })).toThrow(StackBadRequestError);
  });

  test('ISO date strings decode back to Date objects', () => {
    const parsed = parseQueryBody({
      filter: { createdAt: { before: '2024-06-15T12:00:00.000Z' } },
    });
    expect(parsed.filter?.createdAt?.before).toBeInstanceOf(Date);
    expect(parsed.filter?.createdAt?.before?.toISOString()).toBe('2024-06-15T12:00:00.000Z');
  });

  test('a wrongly typed filter field is refused rather than coerced', () => {
    expect(() => parseQueryBody({ filter: { typeId: 42 } })).toThrow(StackBadRequestError);
    expect(() => parseQueryBody({ filter: { tags: 'starred' } })).toThrow(StackBadRequestError);
    expect(() => parseQueryBody({ filter: { content: ['a'] } })).toThrow(StackBadRequestError);
    expect(() => parseQueryBody({ filter: [] })).toThrow(StackBadRequestError);
  });

  test('a non-integer limit is refused rather than coerced', () => {
    expect(() => parseQueryBody({ limit: 2.7 })).toThrow(StackBadRequestError);
    expect(() => parseQueryBody({ limit: 0 })).toThrow(StackBadRequestError);
    expect(() => parseQueryBody({ limit: '10' })).toThrow(StackBadRequestError);
  });

  test('a large limit is reported as requested, not clamped', () => {
    expect(parseQueryBody({ limit: 5000 }).limit).toBe(5000);
  });

  test('a non-string attachment half is refused', () => {
    expect(() => parseQueryBody({ filter: { attachment: { fileId: 7 } } })).toThrow(
      StackBadRequestError,
    );
  });

  test('an unrecognized relatedTo target kind is refused', () => {
    expect(() => parseQueryBody({ filter: { relatedTo: { target: { kind: 'galaxy' } } } })).toThrow(
      StackBadRequestError,
    );
  });

  test('filter.contentPresent travels as an array of paths', () => {
    expect(parseQueryBody({ filter: { contentPresent: ['publishedAt'] } })).toEqual({
      filter: { contentPresent: ['publishedAt'] },
    });
    expect(() => parseQueryBody({ filter: { contentPresent: 'publishedAt' } })).toThrow(
      StackBadRequestError,
    );
    expect(() => parseQueryBody({ filter: { contentPresent: [7] } })).toThrow(StackBadRequestError);
  });

  test('sort.contentField travels beside sort.field, never with it', () => {
    expect(
      parseQueryBody({ sort: { contentField: 'publishedAt', direction: 'desc' } }).sort,
    ).toEqual({ contentField: 'publishedAt', direction: 'desc' });
    expect(() => parseQueryBody({ sort: { field: 'createdAt', contentField: 'x' } })).toThrow(
      StackBadRequestError,
    );
    expect(() => parseQueryBody({ sort: { direction: 'asc' } })).toThrow(StackBadRequestError);
    expect(() => parseQueryBody({ sort: { contentField: 7 } })).toThrow(StackBadRequestError);
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
    expect(() => parseQueryParams(url('?baseId=com.example/note'))).toThrow(StackBadRequestError);
    expect(() => parseQueryBody({ filter: { baseId: 'com.example/note' } })).toThrow(
      StackBadRequestError,
    );
  });

  test('presentAt is refused on both query surfaces', () => {
    expect(() => parseQueryParams(url('?presentAt=latest'))).toThrow(StackBadRequestError);
    expect(() => parseQueryBody({ presentAt: 'latest' })).toThrow(StackBadRequestError);
  });

  // Judged by key, not by value: "stored" is presentAt's default and asks
  // for nothing, but a client sending it still believes the field means
  // something over the wire, and it does not.
  test('presentAt is refused by presence, whatever its value', () => {
    expect(() => parseQueryBody({ presentAt: 'stored' })).toThrow(StackBadRequestError);
    expect(() => parseQueryBody({ filter: { baseId: undefined } })).toThrow(StackBadRequestError);
  });

  test('the refusal names what to send instead', () => {
    expect(() => parseQueryBody({ filter: { baseId: 'x' } })).toThrow(/typeId/);
    expect(() => parseQueryBody({ presentAt: 'latest' })).toThrow(/client-side/);
  });

  // The build-side half, which a client applies before choosing an
  // encoding — so a query body that would be refused and search params
  // that would silently drop the field give one answer, not two.
  describe('assertQueryTravels', () => {
    test('refuses the same two fields, with the same messages', () => {
      expect(() => assertQueryTravels({ filter: { baseId: 'com.example/note' } })).toThrow(
        /typeId/,
      );
      expect(() => assertQueryTravels({ presentAt: 'latest' })).toThrow(/client-side/);
      expect(() => assertQueryTravels({ presentAt: 'stored' })).toThrow(StackBadRequestError);
    });

    // Where it parts company with the parsers above, and deliberately: a
    // request body is written key by key, but a StackQuery is spread and
    // destructured, and Stack.query() already reads an undefined baseId as
    // no baseId. Refusing it here would refuse queries core builds itself.
    test('reads an explicitly undefined field as absent', () => {
      expect(() => assertQueryTravels({ filter: { baseId: undefined } })).not.toThrow();
      expect(() => assertQueryTravels({ presentAt: undefined })).not.toThrow();
    });

    test('passes a query carrying neither', () => {
      expect(() => assertQueryTravels({})).not.toThrow();
      expect(() =>
        assertQueryTravels({ filter: { typeId: 'com.example/note@1' }, limit: 10 }),
      ).not.toThrow();
    });
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

  test('typeId, baseId and createdBy read as they do on GET /records', () => {
    const qs =
      '?typeId=com.example/note@1&baseId=com.example/task&baseId=com.example/memo' +
      '&createdBySubject=entity-a&createdByPrincipal=entity-b&createdByPrincipal=entity-c';
    expect(parseChangeParams(changes(qs)).filter).toEqual({
      typeId: 'com.example/note@1',
      baseId: ['com.example/task', 'com.example/memo'],
      createdBy: { subjectId: 'entity-a', principalId: ['entity-b', 'entity-c'] },
    });
  });

  test('an unrecognized kind is refused rather than dropped from the set', () => {
    expect(() => parseChangeParams(changes('?kind=created&kind=exploded'))).toThrow(
      StackBadRequestError,
    );
  });

  test('include accepts only "record"', () => {
    expect(parseChangeParams(changes('?include=record')).includeRecords).toBe(true);
    expect(() => parseChangeParams(changes('?include=everything'))).toThrow(StackBadRequestError);
  });

  test('includeUnlisted takes only "true" or "false"', () => {
    expect(parseChangeParams(changes('?includeUnlisted=true')).includeUnlisted).toBe(true);
    expect(parseChangeParams(changes('?includeUnlisted=false')).includeUnlisted).toBe(false);
    expect(() => parseChangeParams(changes('?includeUnlisted=1'))).toThrow(StackBadRequestError);
  });

  test('an unrecognized param is refused, and the resume cursor is not one', () => {
    expect(() => parseChangeParams(changes('?token=abc'))).toThrow(/Unknown query param/);
    expect(() => parseChangeParams(changes('?since=abc'))).not.toThrow();
  });

  test('a single-value param appears at most once; a filter list may repeat', () => {
    expect(() => parseChangeParams(changes('?include=record&include=record'))).toThrow(
      /Repeated query param/,
    );
    expect(() => parseChangeParams(changes('?kind=created&kind=deleted'))).not.toThrow();
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
    expect(() => parseIfMatch('"abc"')).toThrow(StackBadRequestError);
    expect(() => parseIfMatch('"5abc"')).toThrow(StackBadRequestError);
    expect(() => parseIfMatch('')).toThrow(StackBadRequestError);
    expect(() => parseIfMatch('*')).toThrow(StackBadRequestError);
  });

  // A version match is exact or it is nothing, so the weak comparator has
  // no meaning here and is not quietly read as its strong form.
  test('a weak comparator is refused', () => {
    expect(() => parseIfMatch('W/"5"')).toThrow(StackBadRequestError);
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
      expect(() => parsePositiveInt(bad, 'version')).toThrow(StackBadRequestError);
    }
  });
});

describe('parseJournalParams', () => {
  const journal = (qs: string) => new URL(`https://s.example${qs}`);

  test('reads an empty query as the whole log, imposing no default page size', () => {
    expect(parseJournalParams(journal('/records/r1/journal'))).toEqual({});
  });

  test('an unrecognized param is refused rather than ignored', () => {
    expect(() => parseJournalParams(journal('/records/r1/journal?sinceSeq=1'))).toThrow(
      /Unknown query param/,
    );
  });

  test('a repeated param is refused', () => {
    expect(() => parseJournalParams(journal('/records/r1/journal?afterSeq=1&afterSeq=9'))).toThrow(
      /Repeated query param/,
    );
  });

  test('round-trips a window', () => {
    expect(parseJournalParams(journal('/records/r1/journal?afterSeq=4&limit=10'))).toEqual({
      afterSeq: 4,
      limit: 10,
    });
  });

  test('accepts zero for either, which assertValidJournalQuery also allows', () => {
    expect(parseJournalParams(journal('/records/r1/journal?afterSeq=0&limit=0'))).toEqual({
      afterSeq: 0,
      limit: 0,
    });
  });

  test('refuses a value that is not a bare non-negative integer', () => {
    for (const qs of ['?limit=-1', '?limit=1.5', '?limit=ten', '?afterSeq=-1', '?afterSeq=1e3']) {
      expect(() => parseJournalParams(journal(`/records/r1/journal${qs}`))).toThrow(
        StackBadRequestError,
      );
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
