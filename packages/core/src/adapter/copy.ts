/**
 * Copying a stack
 * -------------------------------------------------------
 * One stack, read in full from one adapter and written in full to a new
 * store: every Record (soft-deleted and unlisted included) with its version
 * snapshots and journal, `_config` among them as the seed the store is
 * created from, every Type, and every blob. Each is read as the store enumerates it, never by what a Record
 * says, so nothing is filtered on the way. Export, import and moving
 * between storage engines are all this one call, with a different source
 * and a different kind of store to create. Full trust, like any direct
 * adapter access: authorship and history land as recorded, which no write
 * through Stack may do. See docs/spec/portability.md.
 */

import { InvalidAdapterError, OwnerMismatchError } from '../errors.js';
import { resolveQuery } from '../query-validation.js';
import type {
  ConfigContent,
  PlainQuery,
  StackAdapter,
  StackRecordAdapter,
  StoreSeed,
} from '../types/index.js';
import { SYSTEM_TYPES } from '../types/index.js';

/** Creates a new store from `seed` — `LocalAdapter.open({ path, create: 'exclusive', seed })`, say. */
export type CreateStore = (seed: StoreSeed) => Promise<StackAdapter> | StackAdapter;

/** Records read per page; any size works, since every page is written before the next is read. */
const PAGE_SIZE = 100;

/** Every Record a store holds but `_config`, which no query reaches and every store is created from. */
const EVERYTHING: PlainQuery = {
  filter: { includeDeleted: true, includeUnlisted: true },
  sort: { field: 'createdAt', direction: 'asc' },
  limit: PAGE_SIZE,
};

/**
 * Copy everything `from` holds into the store `create` makes from its
 * `_config` record and that record's history, and return that store, open. Not atomic: a failure closes the
 * store part-written, and the caller, whose store it is, removes it. The
 * source must not be written meanwhile; nothing here can check that.
 * See docs/spec/portability.md § Copying a stack.
 */
export async function copyStack(from: StackAdapter, create: CreateStore): Promise<StackAdapter> {
  const listBlobs = from.listBlobs?.bind(from);
  if (!listBlobs) {
    throw new InvalidAdapterError(
      'Cannot copy from this adapter: it has no listBlobs(), so its blobs cannot be enumerated.',
    );
  }
  const config = await from.getRecord(SYSTEM_TYPES.CONFIG);
  if (!config) {
    throw new InvalidAdapterError('Cannot copy from this adapter: it holds no _config record.');
  }
  const [versions, journal] = await Promise.all([
    from.getVersions(config.id),
    from.getJournal(config.id),
  ]);
  const to = await create({ config, history: { versions, journal } });
  try {
    const importRecord = to.importRecord?.bind(to);
    if (!importRecord) refuseTarget('it has no importRecord(), so it cannot write history');
    const listHeld = to.listBlobs?.bind(to);
    if (!listHeld) refuseTarget('it has no listBlobs(), so it could not be copied from in turn');
    await assertNewStore(to, (config.content as ConfigContent).ownerEntityId, listHeld);
    for (const type of await from.listTypes()) await to.saveType(type);
    // Bytes before the Records that name them, as every upload writes them.
    for (const { fileId } of await listBlobs()) await to.putBlob(await from.getBlob(fileId));
    await copyRecords(from, importRecord);
    return to;
  } catch (err) {
    // The failure that stopped the copy is the one to report.
    await to.close?.().catch(() => {});
    throw err;
  }
}

function refuseTarget(why: string): never {
  throw new InvalidAdapterError(`Cannot copy into the store create() returned: ${why}.`);
}

/**
 * A target is a store as its adapter creates one: the source's owner,
 * checked as open() checks it, and nothing held yet — no Record, no Type, no
 * blob. Every end of a copy lists all it holds, so a target is itself a
 * store a later copy can read in full.
 */
async function assertNewStore(
  to: StackAdapter,
  ownerEntityId: string,
  listHeld: NonNullable<StackAdapter['listBlobs']>,
): Promise<void> {
  if (to.ownerEntityId !== ownerEntityId) {
    throw new OwnerMismatchError(ownerEntityId, to.ownerEntityId, 'the store create() returned');
  }
  if ((await to.queryRecords(resolveQuery({ ...EVERYTHING, limit: 1 }))).records.length) {
    refuseTarget('it already holds Records');
  }
  if ((await to.listTypes()).length) refuseTarget('it already holds Types');
  if ((await listHeld()).length) refuseTarget('it already holds blobs');
}

async function copyRecords(
  from: StackAdapter,
  importRecord: NonNullable<StackRecordAdapter['importRecord']>,
): Promise<void> {
  let cursor: string | undefined;
  do {
    const page = await from.queryRecords(resolveQuery({ ...EVERYTHING, cursor }));
    for (const record of page.records) {
      const [versions, journal] = await Promise.all([
        from.getVersions(record.id),
        from.getJournal(record.id),
      ]);
      await importRecord(record, { versions, journal });
    }
    cursor = page.cursor ?? undefined;
  } while (cursor);
}
