/**
 * Record ID and clock-field validation
 * -------------------------------------------------------
 * The rules a caller-supplied `id`, `parentId`, `createdAt` or `updatedAt`
 * is held to before any of them reaches storage. A client may mint its own
 * id and backdate a record's clock, so both are untrusted input here even
 * when the types say otherwise.
 *
 * See docs/spec/data-model.md § Record IDs.
 */

import { isValidIdFormat, idTimestamp, MAX_ID_TIMESTAMP } from './id.js';
import { StackBadRequestError, StackValidationError } from './errors.js';
import type { ValidationError } from './validate.js';

// -------------------------------------------------------
// Record ID validation
// -------------------------------------------------------

const RESERVED_ID_PREFIX = '_';
export const DEFAULT_ID_TIMESTAMP_SKEW_MS = 24 * 60 * 60 * 1000;

/**
 * The same format rule applied to a `parentId` a caller names. Separate
 * from validateRecordId() only for its message: the id under discussion is
 * the destination, not the record being written, and a shared message would
 * report the wrong one. See docs/spec/data-model.md § Reparenting.
 */
export function validateParentId(parentId: string): void {
  if (parentId.startsWith(RESERVED_ID_PREFIX)) {
    throw new StackBadRequestError(
      `Invalid parentId "${parentId}": uses the reserved "${RESERVED_ID_PREFIX}" prefix.`,
    );
  }
  if (!isValidIdFormat(parentId)) {
    throw new StackBadRequestError(
      `Invalid parentId "${parentId}": expected 12 lowercase Crockford base-32 characters.`,
    );
  }
}

/**
 * Format and reserved-prefix checks — full-trust context (Stack.create()).
 * Checked before the format check: the Crockford charset already excludes
 * "_", so a reserved-looking id (e.g. "_config") would otherwise just fail
 * as a generic format error instead of a specific, actionable one.
 *
 * Throws StackBadRequestError, not StackValidationError: a malformed id is
 * structurally bad input the request never gets past — it doesn't reach
 * type-schema validation — the same reasoning that makes an undecodable
 * pagination cursor a StackBadRequestError rather than a content-validation
 * failure. See StackBadRequestError's doc comment.
 */
export function validateRecordId(id: string): void {
  if (id.startsWith(RESERVED_ID_PREFIX)) {
    throw new StackBadRequestError(`ID "${id}" uses the reserved "${RESERVED_ID_PREFIX}" prefix.`);
  }
  if (!isValidIdFormat(id)) {
    throw new StackBadRequestError(
      `Invalid ID "${id}": expected 12 lowercase Crockford base-32 characters.`,
    );
  }
}

/**
 * Validity and range check for the backdating options on unscoped
 * Stack.create(). A Date is only as good as what the caller parsed it
 * from, and the two failure modes both need catching here rather than
 * downstream:
 *
 * - **Invalid Date** (`new Date('13/45/2020')` off a malformed import row)
 *   has a NaN getTime(), and every comparison against NaN is false — so an
 *   unchecked Invalid Date passes the updatedAt/createdAt ordering check
 *   and the id/createdAt skew check by turning them off, mints the
 *   epoch-zero ID `000000000xxx`, and persists a record whose
 *   `createdAt.toISOString()` throws RangeError in serializeRecord() —
 *   making that record, and any wire response containing it,
 *   permanently unreadable.
 * - **Out of encodable range** — before 1970 crockford32Encode() throws a
 *   bare RangeError from deep inside the ID encoder, and past
 *   MAX_ID_TIMESTAMP the derived ID silently grows to 13 characters and
 *   fails isValidIdFormat().
 *
 * Checked at the door for both, as a StackValidationError naming the
 * field. Applies whether or not an `id` is supplied: a clock field outside
 * this range is unrepresentable regardless of where the ID came from.
 */
export function validateClockField(value: Date | undefined, path: string): ValidationError[] {
  if (value === undefined) return [];
  // Type-checked callers always pass a Date, but this option is now
  // reachable from the wire: JSON has no Date, so a server that forwards a
  // parsed `POST /records` body hands us the ISO *string* it deserialized.
  // Without this the very next line is `"2020-…".getTime()` — an unhandled
  // TypeError, a 500 where the caller should have got a 400 naming the
  // field.
  if (!(value instanceof Date)) {
    return [{ path, message: `${path} must be a Date.` }];
  }
  const ms = value.getTime();
  if (Number.isNaN(ms)) {
    return [{ path, message: `${path} is not a valid Date.` }];
  }
  if (ms < 0 || ms > MAX_ID_TIMESTAMP) {
    return [
      {
        path,
        message:
          `${path} is outside the representable range ` +
          `(1970-01-01T00:00:00.000Z…${new Date(MAX_ID_TIMESTAMP).toISOString()}).`,
      },
    ];
  }
  return [];
}

/**
 * Timestamp-prefix plausibility check, shared by callers that compare an
 * ID's embedded millisecond against a different reference each:
 * ScopedStack.create() against the current time for any non-backdated
 * create (a grantee is untrusted and could otherwise mint an ID that
 * forges its sort position, and this is the one check standing between a
 * delegated or grantee caller and doing so), and Stack.create() — reached
 * directly when unscoped, or via ScopedStack.create() when the requester
 * is the owner acting alone with an explicit `createdAt` — against that
 * `createdAt` instead (the two must agree, not silently diverge — see
 * docs/spec/data-model.md § Record IDs). Pass null to disable.
 */
export function validateIdTimestampSkew(
  id: string,
  toleranceMs: number | null,
  referenceMs: number,
  referenceLabel: string,
): void {
  if (toleranceMs === null) return;
  const skew = Math.abs(referenceMs - idTimestamp(id));
  if (skew > toleranceMs) {
    throw new StackValidationError([
      {
        path: 'id',
        message: `ID "${id}" timestamp disagrees with ${referenceLabel} by more than the allowed clock-skew tolerance (${toleranceMs}ms).`,
      },
    ]);
  }
}
