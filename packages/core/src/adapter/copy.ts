/**
 * Copying a stack
 * -------------------------------------------------------
 * One stack, read in full from one adapter and written in full to another:
 * every Record (soft-deleted and unlisted included) with its version
 * snapshots and journal, every Type, and the bytes its attachment records
 * name. Export, import and moving between storage engines are all this one
 * call, with a different pair of adapters. Full trust, like any direct
 * adapter access: authorship and history land as recorded, which no write
 * through Stack may do. See docs/spec/portability.md.
 */

import { InvalidAdapterError, OwnerMismatchError, StackConflictError } from '../errors.js';
import { baseIdOf } from '../schema.js';
import { resolveQuery } from '../query-validation.js';
import type { FileId, PlainQuery, StackAdapter } from '../types/index.js';
import { SYSTEM_TYPES } from '../types/index.js';

/** Records read per page; any size works, since every page is written before the next is read. */
const PAGE_SIZE = 100;

/** Every Record a store holds but `_config`, which no query reaches and each store was created with. */
const EVERYTHING: PlainQuery = {
  filter: { includeDeleted: true, includeUnlisted: true },
  sort: { field: 'createdAt', direction: 'asc' },
  limit: PAGE_SIZE,
};

/**
 * Copy everything `from` holds into `to`, a store newly created with the
 * same `ownerEntityId` and `timezone`. Not atomic: a failure part-way
 * leaves `to` partly written, to be discarded rather than resumed.
 * See docs/spec/portability.md § Copying a stack.
 */
export async function copyStack(from: StackAdapter, to: StackAdapter): Promise<void> {
  if (!to.importRecord) {
    throw new InvalidAdapterError(
      'Cannot copy into this adapter: it has no importRecord(), so it cannot write history.',
    );
  }
  if (to.ownerEntityId !== from.ownerEntityId) {
    throw new OwnerMismatchError(from.ownerEntityId, to.ownerEntityId, 'the copy target');
  }
  if (to.timezone !== from.timezone) {
    throw new InvalidAdapterError(
      `Cannot copy into this adapter: its timezone is ${JSON.stringify(to.timezone)}, ` +
        `but the stack being copied has ${JSON.stringify(from.timezone)}.`,
    );
  }
  const occupied = await to.queryRecords(resolveQuery({ ...EVERYTHING, limit: 1 }));
  if (occupied.records.length) {
    throw new StackConflictError('Cannot copy into a store that already holds records.');
  }

  for (const type of await from.listTypes()) await to.saveType(type);

  const fileIds = new Set<FileId>();
  let cursor: string | undefined;
  do {
    const page = await from.queryRecords(resolveQuery({ ...EVERYTHING, cursor }));
    for (const record of page.records) {
      const [versions, journal] = await Promise.all([
        from.getVersions(record.id),
        from.getJournal(record.id),
      ]);
      await to.importRecord(record, { versions, journal });
      if (baseIdOf(record.typeId) === SYSTEM_TYPES.ATTACHMENT) {
        fileIds.add((record.content as { fileId: FileId }).fileId);
      }
    }
    cursor = page.cursor ?? undefined;
  } while (cursor);

  for (const fileId of fileIds) await to.putBlob(await from.getBlob(fileId));
}
