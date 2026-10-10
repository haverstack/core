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

import { isValidIdFormat, idTimestamp, MAX_ID_TIMESTAMP } from '../id.js';
import { ARGUMENTS_INVALID, StackBadRequestError, StackValidationError } from '../errors.js';
import type { ValidationError } from '../validate.js';

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
 * Format and reserved-prefix checks for a caller-supplied id. The prefix is
 * asked first so "_config" gets a specific refusal, not a generic format
 * one. StackBadRequestError, not StackValidationError: a malformed id never
 * reaches schema validation — see StackBadRequestError's doc comment.
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
 * Validity and range check for a backdated `createdAt`/`updatedAt`. An
 * Invalid Date would switch the ordering and skew checks off rather than
 * fail them, and one outside an id's encodable range has no id to agree
 * with. See docs/spec/data-model.md § Backdating on import.
 */
export function validateClockField(value: Date | undefined, path: string): ValidationError[] {
  if (value === undefined) return [];
  // Reachable from the wire, where JSON has no Date: a forwarded request
  // body hands over an ISO string, which must be a 400 naming the field
  // rather than a TypeError from the getTime() below.
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
 * Whether an id's embedded timestamp is within `skewMs` of `reference`:
 * the current time for a live scoped create, where it stops a grantee
 * forging a sort position, or an explicit `createdAt`, which the id must
 * agree with. Pass null to disable. See docs/spec/data-model.md § Record IDs.
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
    throw new StackValidationError(
      [
        {
          path: 'id',
          message: `ID "${id}" timestamp disagrees with ${referenceLabel} by more than the allowed clock-skew tolerance (${toleranceMs}ms).`,
        },
      ],
      ARGUMENTS_INVALID,
    );
  }
}
