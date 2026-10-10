/**
 * Stack — Write expectations
 * -------------------------------------------------------
 * What a typed collection expects of the record a write addresses: its
 * family on every write, and its exact version on a write whose content is
 * validated against the stored Type. `Stack` checks it against the read it
 * already makes before writing, so a typed write costs what an untyped one
 * does and is refused before anything lands.
 *
 * Internal by construction: the expectation travels under a module-private
 * symbol key on a write verb's options, which `StackClient` never declares
 * and the wire never carries. It needs no server-side counterpart because a
 * record's family never changes — `typeId` moves only through a migration,
 * and a migration stays within its family — so the check cannot race.
 */

import { StackNotFoundError } from './errors.js';
import { baseIdOf } from './schema.js';
import type { BaseId, StackRecord, TypeId } from './types.js';

export const WRITE_EXPECTATION = Symbol('haverstack.writeExpectation');

export type WriteExpectation = {
  readonly baseId: BaseId;
  /** Checked only on a write that patches content. */
  readonly typeId?: TypeId;
};

export type ExpectationOptions = { readonly [WRITE_EXPECTATION]?: WriteExpectation };

/**
 * A content write addressed a record stored at another version of the
 * expected family. Carries the record as read, so the collection can
 * migrate it and retry without reading it again. Never reaches the wire.
 */
export class StoredVersionError extends Error {
  constructor(readonly record: StackRecord) {
    super(`Record "${record.id}" is stored at ${record.typeId}`);
    this.name = 'StoredVersionError';
  }
}

/**
 * Refuse a record outside the expected family with the answer a typed
 * `get()` of it gives: there is no such record in this family.
 */
export const checkFamily = (record: StackRecord, opts: ExpectationOptions | undefined): void => {
  const expected = opts?.[WRITE_EXPECTATION];
  if (expected && baseIdOf(record.typeId) !== expected.baseId) {
    throw new StackNotFoundError(`Record not found: "${record.id}"`);
  }
};

/**
 * checkFamily(), then the exact version when the write patches content: a
 * patch is validated against the record's stored Type, so one written for
 * another version would be checked by a schema it was not written for.
 */
export const checkExpectation = (
  record: StackRecord,
  opts: ExpectationOptions | undefined,
  patchesContent: boolean,
): void => {
  checkFamily(record, opts);
  const typeId = opts?.[WRITE_EXPECTATION]?.typeId;
  if (patchesContent && typeId !== undefined && record.typeId !== typeId) {
    throw new StoredVersionError(record);
  }
};
