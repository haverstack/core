import { describe, test, expect } from 'vitest';
import { contentSortKey, contentSortEntry, compareSortEntries } from '../src/sort.js';
import type { SortEntry } from '../src/sort.js';

describe('contentSortKey', () => {
  test('folds case and combining marks away', () => {
    expect(contentSortKey('Zebra')).toBe('zebra');
    expect(contentSortKey('Émile')).toBe('emile');
    expect(contentSortKey('Ärger')).toBe('arger');
  });

  test('folds compatibility forms onto their base characters', () => {
    expect(contentSortKey('ﬁnal')).toBe('final');
    expect(contentSortKey('Ｍixed')).toBe('mixed');
  });

  test('lowercases without a locale', () => {
    // A locale-sensitive fold maps Turkish İ to a dotted i, so this key —
    // and every index built from it — would differ by runtime locale.
    expect(contentSortKey('İstanbul')).toBe('istanbul');
  });

  test('is idempotent, so a key never re-folds to something else', () => {
    for (const value of ['Émile', 'ﬁnal', 'İstanbul', 'straße', '文字']) {
      expect(contentSortKey(contentSortKey(value))).toBe(contentSortKey(value));
    }
  });

  test('orders accented and mixed-case names beside their plain neighbours', () => {
    const names = ['Zebra', 'apple', 'Émile', 'emile', 'Ärger'];
    const sorted = [...names].sort((a, b) => (contentSortKey(a) < contentSortKey(b) ? -1 : 1));
    expect(sorted).toEqual(['apple', 'Ärger', 'Émile', 'emile', 'Zebra']);
  });
});

describe('contentSortEntry', () => {
  test('reads a date as epoch milliseconds, not as an ISO string', () => {
    expect(contentSortEntry('date', '2020-03-01T00:00:00Z')).toEqual({
      kind: 'num',
      num: Date.parse('2020-03-01T00:00:00Z'),
    });
  });

  test('reads a zone-less date-time as UTC, not in the host zone', () => {
    // The offset is optional in the shape validate.ts accepts, so this is
    // a legal stored value. Resolving it locally would make the index a
    // host writes and the cursor another host re-derives disagree.
    expect(contentSortEntry('date', '2020-03-01T00:00:00')).toEqual({
      kind: 'num',
      num: Date.parse('2020-03-01T00:00:00Z'),
    });
    expect(contentSortEntry('date', '2020-03-01T12:34:56.789')).toEqual({
      kind: 'num',
      num: Date.parse('2020-03-01T12:34:56.789Z'),
    });
  });

  test('a date-only value and its midnight date-time agree', () => {
    expect(contentSortEntry('date', '2020-03-01')).toEqual(
      contentSortEntry('date', '2020-03-01T00:00:00'),
    );
  });

  test('an explicit offset is still honored', () => {
    expect(contentSortEntry('date', '2020-03-01T00:00:00+05:00')).toEqual({
      kind: 'num',
      num: Date.parse('2020-03-01T00:00:00+05:00'),
    });
  });

  test('reads a boolean as 0/1, so false precedes true', () => {
    expect(contentSortEntry('boolean', false)).toEqual({ kind: 'num', num: 0 });
    expect(contentSortEntry('boolean', true)).toEqual({ kind: 'num', num: 1 });
  });

  test('carries both the text and the key it orders by', () => {
    expect(contentSortEntry('string', 'Émile')).toEqual({
      kind: 'text',
      text: 'Émile',
      key: 'emile',
    });
  });

  test('every string-shaped kind orders as text', () => {
    for (const kind of ['string', 'text', 'record-ref', 'file-ref'] as const) {
      expect(contentSortEntry(kind, 'a')).toEqual({ kind: 'text', text: 'a', key: 'a' });
    }
  });

  test('a value of the wrong shape for its declared kind orders as nothing', () => {
    expect(contentSortEntry('number', '7')).toBeNull();
    expect(contentSortEntry('string', 7)).toBeNull();
    expect(contentSortEntry('date', 'not-a-date')).toBeNull();
    expect(contentSortEntry('number', undefined)).toBeNull();
    expect(contentSortEntry('number', null)).toBeNull();
  });

  test('a non-finite number orders as nothing rather than as an endpoint', () => {
    expect(contentSortEntry('number', NaN)).toBeNull();
    expect(contentSortEntry('number', Infinity)).toBeNull();
  });
});

describe('compareSortEntries', () => {
  const num = (n: number): SortEntry => ({ kind: 'num', num: n });
  const text = (s: string): SortEntry => contentSortEntry('string', s) as SortEntry;

  test('absent values sort last in both directions', () => {
    expect(compareSortEntries(null, num(1), 'asc')).toBeGreaterThan(0);
    expect(compareSortEntries(null, num(1), 'desc')).toBeGreaterThan(0);
    expect(compareSortEntries(num(1), null, 'asc')).toBeLessThan(0);
    expect(compareSortEntries(num(1), null, 'desc')).toBeLessThan(0);
    expect(compareSortEntries(null, null, 'asc')).toBe(0);
  });

  test('numbers precede text, and direction reverses that with the values', () => {
    expect(compareSortEntries(num(1), text('a'), 'asc')).toBeLessThan(0);
    expect(compareSortEntries(num(1), text('a'), 'desc')).toBeGreaterThan(0);
  });

  test('text ties on the folded key are broken by the value itself', () => {
    // A total order matters beyond tidiness: keyset pagination needs the
    // page boundary to fall in the same place on every read.
    expect(compareSortEntries(text('Emile'), text('Émile'), 'asc')).toBeLessThan(0);
    expect(compareSortEntries(text('Émile'), text('Emile'), 'asc')).toBeGreaterThan(0);
    expect(compareSortEntries(text('Emile'), text('Emile'), 'asc')).toBe(0);
  });

  test('text orders by code point, the way SQLite orders the same bytes', () => {
    // JS `<` compares UTF-16 code units, which files a surrogate pair
    // below U+E000-U+FFFF; SQLite compares UTF-8 bytes, which is code
    // point order. Ordering by code units here would have the memory
    // adapter and a SQLite one answer one query in two orders.
    const privateUse = '\uE000x'; // U+E000
    const emoji = '\u{1F600}x'; // U+1F600, a surrogate pair in UTF-16
    expect(privateUse < emoji).toBe(false); // what UTF-16 code units say
    expect(compareSortEntries(text(privateUse), text(emoji), 'asc')).toBeLessThan(0);
    expect(compareSortEntries(text(emoji), text(privateUse), 'asc')).toBeGreaterThan(0);
  });

  test('a prefix precedes the string that extends it', () => {
    expect(compareSortEntries(text('item'), text('item10'), 'asc')).toBeLessThan(0);
    expect(compareSortEntries(text('item10'), text('item'), 'asc')).toBeGreaterThan(0);
  });
});
