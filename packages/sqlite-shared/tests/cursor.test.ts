import { describe, test, expect } from 'vitest';
import { NATIVE_SORT_FIELDS, StackQueryError } from '@haverstack/core';
import { encodeCursor, decodeCursor, makeCursor, SORT_FIELDS } from '../src/cursor.js';
import type { ScalarFieldKind, StackRecord } from '@haverstack/core';

const makeRecord = (overrides: Partial<StackRecord> = {}): StackRecord => ({
  id: 'rec01',
  typeId: 'com.example/note@1',
  createdAt: new Date(1000),
  updatedAt: new Date(2000),
  content: {},
  version: 3,
  ...overrides,
});

/** Stands in for the adapter's schema lookup: one declared field. */
const kindOf =
  (field: string, kind: ScalarFieldKind) =>
  (_record: StackRecord, name: string): ScalarFieldKind | undefined =>
    name === field ? kind : undefined;

describe('encodeCursor / decodeCursor', () => {
  test('roundtrips a native sort position', () => {
    const cursor = encodeCursor({ kind: 'native', field: 'createdAt', value: 12345, id: 'rec01' });
    expect(decodeCursor(cursor)).toEqual({
      kind: 'native',
      field: 'createdAt',
      value: 12345,
      id: 'rec01',
    });
  });

  test('roundtrips each content-sort partition', () => {
    expect(
      decodeCursor(encodeCursor({ kind: 'num', field: 'order', value: 2.5, id: 'r1' })),
    ).toEqual({ kind: 'num', field: 'order', value: 2.5, id: 'r1' });
    expect(
      decodeCursor(encodeCursor({ kind: 'text', field: 'title', value: 'Émile', id: 'r1' })),
    ).toEqual({ kind: 'text', field: 'title', value: 'Émile', id: 'r1' });
    expect(decodeCursor(encodeCursor({ kind: 'absent', field: 'title', id: 'r1' }))).toEqual({
      kind: 'absent',
      field: 'title',
      id: 'r1',
    });
  });

  test('a text value survives characters a delimiter would claim', () => {
    for (const value of ['a|b', '{"json":true}', '日本語', '']) {
      const cursor = encodeCursor({ kind: 'text', field: 'a|b', value, id: 'r1' });
      expect(decodeCursor(cursor)).toEqual({ kind: 'text', field: 'a|b', value, id: 'r1' });
    }
  });

  test('throws StackQueryError for non-base64 garbage', () => {
    expect(() => decodeCursor('!!!not-a-cursor!!!')).toThrow(StackQueryError);
  });

  test('throws StackQueryError for base64 that is not a cursor payload', () => {
    expect(() => decodeCursor(btoa('createdAt|12345|rec01'))).toThrow(StackQueryError);
    expect(() => decodeCursor(btoa('{}'))).toThrow(StackQueryError);
    expect(() => decodeCursor(btoa('[1,2,3]'))).toThrow(StackQueryError);
  });

  test('throws StackQueryError for an unknown native sort field', () => {
    expect(() =>
      decodeCursor(btoa(JSON.stringify({ k: 'native', f: 'bogus', i: 'r1', v: 1 }))),
    ).toThrow(StackQueryError);
  });

  test('throws StackQueryError for a value of the wrong shape for its partition', () => {
    expect(() =>
      decodeCursor(btoa(JSON.stringify({ k: 'native', f: 'createdAt', i: 'r1', v: 'soon' }))),
    ).toThrow(StackQueryError);
    expect(() =>
      decodeCursor(btoa(JSON.stringify({ k: 'text', f: 'title', i: 'r1', v: 7 }))),
    ).toThrow(StackQueryError);
  });
});

describe('makeCursor', () => {
  test('encodes the native field the query sorts by', () => {
    expect(decodeCursor(makeCursor(makeRecord(), undefined))).toEqual({
      kind: 'native',
      field: 'createdAt',
      value: 1000,
      id: 'rec01',
    });
    expect(decodeCursor(makeCursor(makeRecord(), { field: 'updatedAt' }))).toEqual({
      kind: 'native',
      field: 'updatedAt',
      value: 2000,
      id: 'rec01',
    });
    expect(decodeCursor(makeCursor(makeRecord(), { field: 'version' }))).toEqual({
      kind: 'native',
      field: 'version',
      value: 3,
      id: 'rec01',
    });
  });

  test('encodes a content field by its declared kind, not its stored shape', () => {
    const record = makeRecord({ content: { publishedAt: '2021-01-01T00:00:00Z' } });
    expect(
      decodeCursor(
        makeCursor(record, { contentField: 'publishedAt' }, kindOf('publishedAt', 'date')),
      ),
    ).toEqual({
      kind: 'num',
      field: 'publishedAt',
      value: Date.parse('2021-01-01T00:00:00Z'),
      id: 'rec01',
    });
  });

  test('a record with no value at the field encodes as the absent partition', () => {
    const record = makeRecord({ content: { title: 'set' } });
    expect(
      decodeCursor(makeCursor(record, { contentField: 'missing' }, kindOf('title', 'string'))),
    ).toEqual({ kind: 'absent', field: 'missing', id: 'rec01' });
  });
});

describe('SORT_FIELDS', () => {
  // This package's name for the set, not a second copy of it: a cursor's
  // `native` field is narrowed against exactly what core admits as a sort
  // field, and a fourth column added there must not need finding here too.
  test('is exactly the set core admits as a sort field', () => {
    expect(SORT_FIELDS).toEqual([...NATIVE_SORT_FIELDS]);
  });

  test('round-trips a cursor on every field it names', () => {
    const record = makeRecord();
    for (const field of NATIVE_SORT_FIELDS) {
      expect(decodeCursor(makeCursor(record, { field }))).toEqual({
        kind: 'native',
        field,
        value: expect.any(Number),
        id: record.id,
      });
    }
  });
});
