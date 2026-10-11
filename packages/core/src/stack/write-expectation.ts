/**
 * Stack — Write expectations
 * -------------------------------------------------------
 * What a type handle expects of the record a write addresses: its
 * family on every write, and its exact version on a write whose content is
 * validated against the stored Type. `Stack` checks it against the read it
 * already makes before writing, so a typed write costs what an untyped one
 * does and is refused before anything lands.
 *
 * Internal by construction: the expectation travels under a module-private
 * symbol key on a write verb's options, which `StackClient` never declares
 * and the wire never carries. It needs no server-side counterpart because a
 * record's family never changes — `typeId` moves only through a migration,
 * and a migration stays within its family. A write that does not re-read
 * the record pins `ifVersion` to the read the check was made against, so a
 * write landing in between is a conflict rather than an unchecked write.
 */

import { StackNotFoundError } from '../errors.js';
import { baseIdOf } from '../schema.js';
import type { DeleteRecordOptions, DeleteResult, StackClient } from './client.js';
import type {
  AssociationEdit,
  AuthorityAssociation,
  BaseId,
  DataAssociation,
  IfVersionOptions,
  RecordChangeSet,
  RecordId,
  RecordVersion,
  StackRecord,
  TypeId,
} from '../types/index.js';

export const WRITE_EXPECTATION = Symbol('haverstack.writeExpectation');

export type WriteExpectation = {
  readonly baseId: BaseId;
  /** Checked only on a write that patches content, unless `exact`. */
  readonly typeId?: TypeId;
  /** Hold every write to `typeId`, as a typed handle's write is. */
  readonly exact?: boolean;
};

export type ExpectationOptions = { readonly [WRITE_EXPECTATION]?: WriteExpectation };

/**
 * A content write addressed a record stored at another version of the
 * expected family. Carries the record as read, so a caller holding the
 * handle can migrate it and retry without reading it again. Never reaches the wire.
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
 * A restore puts back the snapshot's `typeId`, so the snapshot is held to
 * the family too: one from before the record migrated into it is not a
 * version of a record in that family.
 */
export const checkSnapshotFamily = (
  id: RecordId,
  snapshot: RecordVersion,
  opts: ExpectationOptions | undefined,
): void => {
  const expected = opts?.[WRITE_EXPECTATION];
  if (expected && baseIdOf(snapshot.typeId) !== expected.baseId) {
    throw new StackNotFoundError(`Version ${snapshot.version} not found for record "${id}"`);
  }
};

/**
 * The exact version, on a write that patches content: a patch is validated
 * against the record's stored Type, so one written for another version
 * would be checked by a schema it was not written for. Called after the
 * tombstone and `ifVersion` refusals, which a caller is owed first.
 */
export const checkStoredVersion = (
  record: StackRecord,
  opts: ExpectationOptions | undefined,
  patchesContent: boolean,
): void => {
  if (storedVersionDiffers(record, opts, patchesContent)) throw new StoredVersionError(record);
};

export const storedVersionDiffers = (
  record: StackRecord,
  opts: ExpectationOptions | undefined,
  patchesContent: boolean,
): boolean => {
  const expected = opts?.[WRITE_EXPECTATION];
  if (expected?.typeId === undefined || record.typeId === expected.typeId) return false;
  return patchesContent || expected.exact === true;
};

/**
 * The write verbs of `StackClient` as `Stack` and `ScopedStack` implement
 * them, each taking an expectation. Internal: a collection casts its client
 * to this once, so the key stays off the public surface and every call that
 * passes one is still type-checked.
 */
export type ExpectingClient = Omit<
  StackClient,
  | 'mutate'
  | 'patchContent'
  | 'associate'
  | 'dissociate'
  | 'amendAssociations'
  | 'grantAccess'
  | 'revokeAccess'
  | 'amendAccess'
  | 'delete'
  | 'undelete'
  | 'restoreVersion'
> & {
  mutate(
    id: RecordId,
    changes: RecordChangeSet,
    opts?: IfVersionOptions & ExpectationOptions,
  ): Promise<StackRecord>;
  patchContent(
    id: RecordId,
    patch: Record<string, unknown | null>,
    opts?: IfVersionOptions & ExpectationOptions,
  ): Promise<StackRecord>;
  associate(
    id: RecordId,
    associations: DataAssociation[],
    opts?: ExpectationOptions,
  ): Promise<StackRecord>;
  dissociate(
    id: RecordId,
    associations: DataAssociation[],
    opts?: ExpectationOptions,
  ): Promise<StackRecord>;
  amendAssociations(
    id: RecordId,
    changes: AssociationEdit[],
    opts?: ExpectationOptions,
  ): Promise<StackRecord>;
  grantAccess(
    id: RecordId,
    permissions: AuthorityAssociation[],
    opts?: ExpectationOptions,
  ): Promise<StackRecord>;
  revokeAccess(
    id: RecordId,
    permissions: AuthorityAssociation[],
    opts?: ExpectationOptions,
  ): Promise<StackRecord>;
  amendAccess(
    id: RecordId,
    changes: AssociationEdit[],
    opts?: ExpectationOptions,
  ): Promise<StackRecord>;
  delete(id: RecordId, opts?: DeleteRecordOptions & ExpectationOptions): Promise<DeleteResult>;
  undelete(id: RecordId, opts?: IfVersionOptions & ExpectationOptions): Promise<StackRecord>;
  restoreVersion(
    id: RecordId,
    version: number,
    opts?: IfVersionOptions & ExpectationOptions,
  ): Promise<StackRecord>;
};
