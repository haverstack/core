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
// Tracks the highest timestamp an ID has been minted for, so a backward
// clock step (NTP correction, suspend/resume) can't produce an ID that
// sorts before ones already generated in this process.
let lastTimestamp = 0;

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
  const modulus = Math.pow(BASE, RAND_SUFFIX_LENGTH);
  const arr = new Uint32Array(1);
  // Rejection sampling to avoid modulo bias
  let value: number;
  do {
    crypto.getRandomValues(arr);
    value = arr[0];
  } while (value > Math.floor(0xffffffff / modulus) * modulus);
  return pad(crockford32Encode(value % modulus), RAND_SUFFIX_LENGTH);
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

export const _setLastTimestamp = (timestamp: number): void => {
  lastTimestamp = timestamp;
};

/** Resets all module-level generator state. For test isolation only. */
export const _resetIdState = (): void => {
  lastNowId = '';
  lastRandChars = '';
  lastTimestamp = 0;
};

// -------------------------------------------------------
// Public API
// -------------------------------------------------------

/**
 * Generate a new Stack record ID. Time-sortable: lexicographic order
 * matches creation order, with same-millisecond IDs monotonically
 * incremented. Throws IdGenerationOverflowError past 32^3 IDs in one
 * millisecond.
 *
 * @param timestamp - Override the timestamp (ms since epoch). Defaults to Date.now().
 */
export const generateId = (timestamp: number = Date.now()): string => {
  const effectiveTimestamp = Math.max(timestamp, lastTimestamp);
  const nowId = pad(crockford32Encode(effectiveTimestamp), MIN_TIMESTAMP_LENGTH);
  const randChars = nowId !== lastNowId ? generateRandChars() : incrementRandChars(lastRandChars);

  lastTimestamp = effectiveTimestamp;
  lastNowId = nowId;
  lastRandChars = randChars;

  return nowId + randChars;
};

/**
 * Mint an ID for an arbitrary (typically past) timestamp — used by
 * Stack.create() to derive an ID from an explicit `createdAt` when
 * importing historical records. Deliberately bypasses generateId()'s
 * monotonic `lastTimestamp` floor: that floor exists to protect *live* ID
 * generation from a backward clock step (NTP correction, suspend/resume),
 * and would otherwise clamp a deliberately historical timestamp forward to
 * "now" the moment the process has minted any live ID past it — silently
 * defeating the backdate it was asked for. Same-millisecond uniqueness for
 * a historical timestamp is therefore left to a fresh random suffix each
 * call rather than the live incrementing scheme; a collision surfaces the
 * same way any client-supplied id collision does, as StackConflictError
 * from the adapter.
 */
export const generateIdForTimestamp = (timestamp: number): string => {
  const nowId = pad(crockford32Encode(timestamp), MIN_TIMESTAMP_LENGTH);
  return nowId + generateRandChars();
};

// -------------------------------------------------------
// Format validation
// -------------------------------------------------------

const ID_LENGTH = MIN_TIMESTAMP_LENGTH + RAND_SUFFIX_LENGTH;
const ID_FORMAT = new RegExp(`^[${CHARACTERS}]{${ID_LENGTH}}$`);

/**
 * Check whether a string has the shape of a Stack record ID: exactly
 * 12 lowercase Crockford base-32 characters. Does not check whether the
 * ID actually exists — see Stack.create()'s duplicate check for that.
 */
export const isValidIdFormat = (id: string): boolean => ID_FORMAT.test(id);

/**
 * Extract the timestamp (ms since epoch) encoded in an ID's prefix.
 * Only meaningful for IDs that pass isValidIdFormat().
 */
export const idTimestamp = (id: string): number =>
  crockford32Decode(id.slice(0, MIN_TIMESTAMP_LENGTH));
