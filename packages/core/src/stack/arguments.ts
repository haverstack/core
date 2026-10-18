/**
 * Stack — Write arguments
 * -------------------------------------------------------
 * The shape checks each aspect write owes its arguments before anything is
 * read. `Stack` and `ScopedStack` both call them, `ScopedStack` ahead of its
 * gates, so a malformed argument earns the same refusal from every
 * requester rather than a validation error for the owner and a not-found
 * for everyone else. See docs/spec/disclosure.md § The order a write's
 * refusals are asked in.
 */

import { ARGUMENTS_INVALID, StackBadRequestError, StackValidationError } from '../errors.js';
import {
  assertAuthorityAssociations,
  assertDataAssociations,
  validateAssociations,
} from '../associations/validation.js';
import type { Association } from '../types/index.js';

/**
 * The split the wire parsers make: a patch that is not an object is not a
 * patch at all (400), while a named argument of the wrong type is a 422
 * naming it. See docs/spec/wire-format.md § Unrecognized input.
 */
export function assertContentPatch(patch: unknown): asserts patch is Record<string, unknown> {
  if (typeof patch === 'object' && patch !== null && !Array.isArray(patch)) return;
  throw new StackBadRequestError('A content patch is an object of content keys.');
}

export function assertParentArgument(parentId: unknown): asserts parentId is string | null {
  if (parentId === null || typeof parentId === 'string') return;
  argumentError('parentId', 'parentId must be a record id, or null for the root.');
}

export function assertUnlistedArgument(unlisted: unknown): asserts unlisted is boolean {
  if (typeof unlisted === 'boolean') return;
  argumentError('unlisted', 'unlisted must be a boolean.');
}

/**
 * A whole replacement set: a list, on its own surface — asked before the
 * shape checks, so a misrouted element is reported as the wrong surface
 * rather than as a malformed value of the right one — of well-formed,
 * distinct elements.
 */
export function assertAssociationSet(
  list: unknown,
  param: 'associations' | 'permissions',
): asserts list is Association[] {
  if (!Array.isArray(list)) argumentError(param, `${param} must be an array.`);
  if (param === 'associations') assertDataAssociations(list, param);
  else assertAuthorityAssociations(list, param);
  const errors = validateAssociations(list, param);
  if (errors.length > 0) throw new StackValidationError(errors, ARGUMENTS_INVALID);
}

function argumentError(path: string, message: string): never {
  throw new StackValidationError([{ path, message }], ARGUMENTS_INVALID);
}
