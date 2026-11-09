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

/** The next suffix after `randChars`, or null once the space is spent. */
const incrementRandChars = (randChars: string): string | null => {
  const next = crockford32Encode(crockford32Decode(randChars) + 1);
  return next.length > RAND_SUFFIX_LENGTH ? null : pad(next, RAND_SUFFIX_LENGTH);
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
 * Largest timestamp that still encodes to the 9-character prefix an ID's
 * format requires (32^9 - 1, 3084-12-12T12:41:28.831Z); past it the library
 * would mint an ID it rejects. Only generateIdForTimestamp() can reach it,
 * since generateId() encodes Date.now().
 */
export const MAX_ID_TIMESTAMP = Math.pow(BASE, MIN_TIMESTAMP_LENGTH) - 1;

/**
 * Generate a new record ID, `timestamp` defaulting to now; lexicographic
 * order matches creation order. A spent millisecond carries into the next
 * rather than failing, so capacity never depends on where the random suffix
 * started. See docs/spec/data-model.md § Record IDs.
 */
export const generateId = (timestamp: number = Date.now()): string => {
  let effectiveTimestamp = Math.max(timestamp, lastTimestamp);
  let nowId = pad(crockford32Encode(effectiveTimestamp), MIN_TIMESTAMP_LENGTH);
  let randChars = nowId === lastNowId ? incrementRandChars(lastRandChars) : generateRandChars();

  if (randChars === null) {
    effectiveTimestamp += 1;
    nowId = pad(crockford32Encode(effectiveTimestamp), MIN_TIMESTAMP_LENGTH);
    randChars = generateRandChars();
  }

  lastTimestamp = effectiveTimestamp;
  lastNowId = nowId;
  lastRandChars = randChars;

  return nowId + randChars;
};

/**
 * Mint an ID for an arbitrary, typically past, timestamp — Stack.create()'s
 * backdated import. Bypasses generateId()'s monotonic floor, which guards
 * live minting from clock steps but would clamp a historical timestamp to
 * now. Uniqueness rests on a fresh random suffix; a collision surfaces as
 * the adapter's StackConflictError.
 */
export const generateIdForTimestamp = (timestamp: number): string => {
  if (!Number.isFinite(timestamp) || timestamp < 0 || timestamp > MAX_ID_TIMESTAMP) {
    throw new IdGenerationError(
      `Timestamp ${timestamp} cannot be encoded as an ID: expected 0…${MAX_ID_TIMESTAMP} ` +
        `(1970-01-01T00:00:00.000Z…${new Date(MAX_ID_TIMESTAMP).toISOString()}).`,
    );
  }
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
