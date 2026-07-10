import { describe, test, expect, beforeEach, vi } from 'vitest';
import {
  generateId,
  crockford32Encode,
  crockford32Decode,
  isValidIdFormat,
  idTimestamp,
  RAND_SUFFIX_LENGTH,
  BASE,
  IdGenerationOverflowError,
  _setLastNowId,
  _setLastRandChars,
  _resetIdState,
} from '../src/id.js';

// -------------------------------------------------------
// Encoding / decoding
// -------------------------------------------------------

describe('crockford32Encode', () => {
  test('encodes single-digit values correctly', () => {
    expect(crockford32Encode(0)).toBe('0');
    expect(crockford32Encode(1)).toBe('1');
    expect(crockford32Encode(10)).toBe('a');
    expect(crockford32Encode(18)).toBe('j');
    expect(crockford32Encode(20)).toBe('m');
    expect(crockford32Encode(22)).toBe('p');
    expect(crockford32Encode(27)).toBe('v');
    expect(crockford32Encode(31)).toBe('z');
  });

  test('encodes multi-digit values to the correct number of digits', () => {
    expect(crockford32Encode(32)).toBe('10');
    expect(crockford32Encode(1024)).toBe('100');
    expect(crockford32Encode(32768)).toBe('1000');
    expect(crockford32Encode(1048576)).toBe('10000');
    expect(crockford32Encode(33554432)).toBe('100000');
    expect(crockford32Encode(1073741824)).toBe('1000000');
    expect(crockford32Encode(34359738368)).toBe('10000000');
    expect(crockford32Encode(1099511627776)).toBe('100000000');
    expect(crockford32Encode(35184372088832)).toBe('1000000000');
  });

  test('throws RangeError for negative numbers', () => {
    expect(() => crockford32Encode(-1)).toThrow(RangeError);
  });

  test('produces only URL-safe characters', () => {
    // Spot-check a range of values — all chars should be [0-9a-z] minus i, l, o, u
    const urlSafe = /^[0-9a-hj-km-np-tv-z]+$/;
    for (const n of [0, 1, 31, 32, 1000, 999999, Date.now()]) {
      expect(crockford32Encode(n)).toMatch(urlSafe);
    }
  });
});

describe('crockford32Decode', () => {
  test('decodes single characters correctly', () => {
    expect(crockford32Decode('0')).toBe(0);
    expect(crockford32Decode('1')).toBe(1);
    expect(crockford32Decode('a')).toBe(10);
    expect(crockford32Decode('j')).toBe(18);
    expect(crockford32Decode('m')).toBe(20);
    expect(crockford32Decode('p')).toBe(22);
    expect(crockford32Decode('v')).toBe(27);
    expect(crockford32Decode('z')).toBe(31);
  });

  test('decodes multi-character strings correctly', () => {
    expect(crockford32Decode('10')).toBe(32);
    expect(crockford32Decode('100')).toBe(1024);
    expect(crockford32Decode('1000')).toBe(32768);
    expect(crockford32Decode('10000')).toBe(1048576);
    expect(crockford32Decode('100000')).toBe(33554432);
    expect(crockford32Decode('1000000')).toBe(1073741824);
    expect(crockford32Decode('10000000')).toBe(34359738368);
    expect(crockford32Decode('100000000')).toBe(1099511627776);
    expect(crockford32Decode('1000000000')).toBe(35184372088832);
  });

  test('throws RangeError for empty string', () => {
    expect(() => crockford32Decode('')).toThrow(RangeError);
  });

  test('throws RangeError for invalid characters', () => {
    expect(() => crockford32Decode('l')).toThrow(RangeError); // excluded: looks like 1
    expect(() => crockford32Decode('i')).toThrow(RangeError); // excluded: looks like 1
    expect(() => crockford32Decode('o')).toThrow(RangeError); // excluded: looks like 0
    expect(() => crockford32Decode('u')).toThrow(RangeError); // excluded: looks like v
    expect(() => crockford32Decode('!')).toThrow(RangeError);
  });
});

describe('encode/decode roundtrip', () => {
  test('decode(encode(n)) === n for a range of values', () => {
    const values = [0, 1, 31, 32, 100, 1000, 32768, Date.now()];
    for (const n of values) {
      expect(crockford32Decode(crockford32Encode(n))).toBe(n);
    }
  });
});

// -------------------------------------------------------
// ID generation
// -------------------------------------------------------

describe('generateId', () => {
  beforeEach(() => {
    _resetIdState();
  });

  test('returns a string of at least 12 characters', () => {
    const id = generateId();
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThanOrEqual(12);
  });

  test('gets more digits for dates far in the future', () => {
    const id = generateId(35184372088833);
    expect(id.length).toBeGreaterThanOrEqual(13);
  });

  test('timestamp prefix matches the encoded timestamp', () => {
    const now = Date.now();
    const id = generateId(now);
    const prefix = id.substring(0, 9);
    expect(prefix).toBe(crockford32Encode(now));
  });

  test('generated IDs contain only URL-safe characters', () => {
    const urlSafe = /^[0-9a-hj-km-np-tv-z]+$/;
    for (let i = 0; i < 20; i++) {
      expect(generateId()).toMatch(urlSafe);
    }
  });

  test('IDs generated at different times are unique', () => {
    const ids = new Set([100, 200, 300, 400, 500].map((offset) => generateId(Date.now() + offset)));
    expect(ids.size).toBe(5);
  });

  test('IDs generated at different times are time-sortable', () => {
    const t1 = Date.now();
    const t2 = t1 + 1000;
    const id1 = generateId(t1);
    const id2 = generateId(t2);
    expect(id1 < id2).toBe(true);
  });

  test('same-millisecond IDs have identical timestamp prefix', () => {
    const now = new Date('2024-01-01T00:00:00.0').valueOf();
    const ids = Array.from({ length: 5 }, () => generateId(now));
    const prefixes = new Set(ids.map((id) => id.slice(0, -RAND_SUFFIX_LENGTH)));
    expect(prefixes.size).toBe(1);
  });

  test('same-millisecond IDs are unique', () => {
    const now = new Date('2024-01-01T00:00:00.0').valueOf();
    const ids = Array.from({ length: 5 }, () => generateId(now));
    expect(new Set(ids).size).toBe(5);
  });

  test('same-millisecond IDs have monotonically incrementing suffixes', () => {
    const now = new Date('2024-01-01T00:00:00.0').valueOf();
    const ids = Array.from({ length: 5 }, () => generateId(now));
    const suffixes = ids.map((id) => crockford32Decode(id.slice(-RAND_SUFFIX_LENGTH)));
    for (let i = 1; i < suffixes.length; i++) {
      expect(suffixes[i]).toBe(suffixes[i - 1] + 1);
    }
  });

  test('throws IdGenerationOverflowError when same-millisecond IDs are exhausted', () => {
    const generateAllSuffixes = () => {
      const now = Date.now();
      const count = Math.pow(BASE, RAND_SUFFIX_LENGTH) - 1;
      for (let i = 0; i < count; i++) {
        generateId(now);
      }
    };
    expect(generateAllSuffixes).toThrow(IdGenerationOverflowError);
  });

  test('incremented suffix with leading zero is padded correctly (regression #90)', () => {
    // Timestamp prefix '1hk1p9749' corresponds to ms timestamp 1704085200009
    const now = 1704085200009;
    _setLastNowId('1hk1p9749');
    _setLastRandChars('0ar');
    const id = generateId(now);
    // A buggy implementation would drop the leading zero: '1hk1p9749as' (11 chars)
    expect(id).toBe('1hk1p97490as');
  });

  test('a fresh random draw can produce the maximum suffix "zzz" (regression #55: modulus off-by-one)', () => {
    const spy = vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation((arr) => {
      (arr as Uint32Array)[0] = Math.pow(BASE, RAND_SUFFIX_LENGTH) - 1; // 32767
      return arr;
    });
    const id = generateId(Date.now());
    expect(id.slice(-RAND_SUFFIX_LENGTH)).toBe('zzz');
    spy.mockRestore();
  });

  test('clamps to the last timestamp when the clock regresses (regression #55)', () => {
    const t2 = new Date('2024-06-01T00:00:05.000Z').valueOf();
    const t1 = t2 - 5000; // clock steps backward after t2

    const id1 = generateId(t2);
    const id2 = generateId(t1);

    // Still sorts after id1 despite the clock reading an earlier time.
    expect(id2 > id1).toBe(true);
    // Clamped to the same effective timestamp, so the prefix is unchanged
    // and the suffix simply increments.
    expect(id2.slice(0, -RAND_SUFFIX_LENGTH)).toBe(id1.slice(0, -RAND_SUFFIX_LENGTH));
  });

  test('does not clamp when the clock advances normally', () => {
    const t1 = new Date('2024-06-01T00:00:00.000Z').valueOf();
    const t2 = t1 + 5000;

    const id1 = generateId(t1);
    const id2 = generateId(t2);

    expect(id2.slice(0, -RAND_SUFFIX_LENGTH)).toBe(crockford32Encode(t2).padStart(9, '0'));
    expect(id1 < id2).toBe(true);
  });
});

// -------------------------------------------------------
// ID format validation
// -------------------------------------------------------

describe('isValidIdFormat', () => {
  test('accepts a freshly generated ID', () => {
    expect(isValidIdFormat(generateId())).toBe(true);
  });

  test('rejects the wrong length', () => {
    expect(isValidIdFormat('short')).toBe(false);
    expect(isValidIdFormat('a'.repeat(13))).toBe(false);
  });

  test('rejects characters outside the Crockford charset', () => {
    expect(isValidIdFormat('1111111111i1')).toBe(false); // 'i' excluded
    expect(isValidIdFormat('1111111111l1')).toBe(false); // 'l' excluded
    expect(isValidIdFormat('1111111111o1')).toBe(false); // 'o' excluded
    expect(isValidIdFormat('1111111111u1')).toBe(false); // 'u' excluded
  });

  test('rejects uppercase', () => {
    expect(isValidIdFormat('ABCDEFGHJ123')).toBe(false);
  });
});

describe('idTimestamp', () => {
  test('extracts the encoded timestamp from an ID prefix', () => {
    const now = Date.now();
    const id = generateId(now);
    expect(idTimestamp(id)).toBe(now);
  });
});
