/**
 * Stack — ID Generation
 * -------------------------------------------------------
 * Crockford base-32 encoded IDs. Time-sortable, human-readable,
 * and URL-safe. Unique within a stack.
 *
 * Format: 9-char timestamp prefix + 3-char random suffix = 12 chars total.
 *
 * Ported from https://github.com/cuibonobo/cuibonobo.com/blob/main/src/lib/id.ts
 * with crypto.randomInt replaced by crypto.getRandomValues for
 * runtime-agnostic compatibility (Node, browser, Deno, etc.)
 */

const CHARACTERS = '0123456789abcdefghjkmnpqrstvwxyz';

export const BASE = CHARACTERS.length;

const MIN_TIMESTAMP_LENGTH = 9;
export const RAND_SUFFIX_LENGTH = 3;

// Module-level state for monotonicity within the same millisecond
let lastNowId = '';
let lastRandChars = '';

// -------------------------------------------------------
// Errors
// -------------------------------------------------------

export class IdGenerationError extends Error {
  constructor(message = '') {
    super(message || 'An ID could not be generated.');
    this.name = 'IdGenerationError';
  }
}

export class IdGenerationOverflowError extends IdGenerationError {
  constructor(message = '') {
    super(message || 'Too many IDs have been generated in the same millisecond.');
    this.name = 'IdGenerationOverflowError';
  }
}

// -------------------------------------------------------
// Encoding / decoding
// -------------------------------------------------------

export const crockford32Encode = (n: number): string => {
  if (n < 0) {
    throw new RangeError('Not defined for negative numbers!');
  }

  n = Math.floor(n);

  if (n === 0) {
    return CHARACTERS[0];
  }

  let result = '';
  while (n > 0) {
    result = CHARACTERS[n % BASE] + result;
    n = Math.floor(n / BASE);
  }
  return result;
};

export const crockford32Decode = (s: string): number => {
  if (s.length === 0) {
    throw new RangeError('String must not be empty!');
  }

  s = s.toLowerCase();
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const val = CHARACTERS.indexOf(s[s.length - i - 1]);
    if (val < 0) {
      throw new RangeError(`Undefined character in string: "${s[s.length - i - 1]}"`);
    }
    n += val * Math.pow(BASE, i);
  }
  return n;
};

// -------------------------------------------------------
// Internal helpers
// -------------------------------------------------------

const pad = (chars: string, length: number): string => chars.padStart(length, CHARACTERS[0]);

/**
 * Generate a random suffix using Web Crypto API.
 * Works in Node (>=19), browsers, Deno, and Bun.
 */
const generateRandChars = (): string => {
  const max = Math.pow(BASE, RAND_SUFFIX_LENGTH) - 1;
  const arr = new Uint32Array(1);
  // Rejection sampling to avoid modulo bias
  let value: number;
  do {
    crypto.getRandomValues(arr);
    value = arr[0];
  } while (value > Math.floor(0xffffffff / max) * max);
  return pad(crockford32Encode(value % max), RAND_SUFFIX_LENGTH);
};

const incrementRandChars = (randChars: string): string => {
  const next = crockford32Encode(crockford32Decode(randChars) + 1);
  if (next.length > RAND_SUFFIX_LENGTH) {
    throw new IdGenerationOverflowError();
  }
  return pad(next, RAND_SUFFIX_LENGTH);
};

// -------------------------------------------------------
// Test hooks (package-private)
// -------------------------------------------------------

export const _setLastNowId = (chars: string): void => {
  if (chars.length < MIN_TIMESTAMP_LENGTH) {
    throw new RangeError(`lastNowId must have at least ${MIN_TIMESTAMP_LENGTH} characters.`);
  }
  lastNowId = chars;
};

export const _setLastRandChars = (chars: string): void => {
  if (chars.length !== RAND_SUFFIX_LENGTH) {
    throw new RangeError(`lastRandChars must have exactly ${RAND_SUFFIX_LENGTH} characters.`);
  }
  lastRandChars = chars;
};

// -------------------------------------------------------
// Public API
// -------------------------------------------------------

/**
 * Generate a new Stack record ID.
 *
 * IDs are time-sortable: lexicographic order matches creation order.
 * Same-millisecond IDs are monotonically incremented to preserve order
 * and avoid collisions. Throws IdGenerationOverflowError if more than
 * BASE^RAND_SUFFIX_LENGTH (32^3 = 32,768) IDs are generated in one millisecond.
 *
 * @param timestamp - Override the timestamp (ms since epoch). Defaults to Date.now().
 */
export const generateId = (timestamp: number = Date.now()): string => {
  const nowId = pad(crockford32Encode(timestamp), MIN_TIMESTAMP_LENGTH);
  const randChars = nowId !== lastNowId ? generateRandChars() : incrementRandChars(lastRandChars);

  lastNowId = nowId;
  lastRandChars = randChars;

  return nowId + randChars;
};
