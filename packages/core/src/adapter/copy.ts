/**
 * Copying a stack
 * -------------------------------------------------------
 * One stack, read in full from one adapter and written in full to a new
 * store created with its identity: every Record (soft-deleted and unlisted
 * included) with its version snapshots and journal, every Type, and every
 * blob. Each is read as the store enumerates it, never by what a Record
 * says, so nothing is filtered on the way. Export, import and moving
 * between storage engines are all this one call, with a different source
 * and a different kind of store to create. Full trust, like any direct
 * adapter access: authorship and history land as recorded, which no write
 * through Stack may do. See docs/spec/portability.md.
 */

import { InvalidAdapterError } from '../errors.js';
import { resolveQuery } from '../query-validation.js';
import type { EntityId, PlainQuery, StackAdapter } from '../types/index.js';

/** What a store is created with: the identity `_config` holds. */
export type StackIdentity = { ownerEntityId: EntityId; timezone: string | undefined };

/** Creates a new, empty store with `identity` — `LocalAdapter.open({ create: 'exclusive', ...identity })`, say. */
export type CreateStore = (identity: StackIdentity) => Promise<StackAdapter> | StackAdapter;

/** Records read per page; any size works, since every page is written before the next is read. */
const PAGE_SIZE = 100;

/** Every Record a store holds but `_config`, which no query reaches and each store was created with. */
const EVERYTHING: PlainQuery = {
  filter: { includeDeleted: true, includeUnlisted: true },
  sort: { field: 'createdAt', direction: 'asc' },
  limit: PAGE_SIZE,
};

/**
 * Copy everything `from` holds into the store `create` makes with `from`'s
 * identity, and return that store, open. Not atomic: a failure closes the
 * store part-written, to be discarded rather than resumed.
 * See docs/spec/portability.md § Copying a stack.
 */
export async function copyStack(from: StackAdapter, create: CreateStore): Promise<StackAdapter> {
  const listBlobs = from.listBlobs?.bind(from);
  if (!listBlobs) {
    throw new InvalidAdapterError(
      'Cannot copy from this adapter: it has no listBlobs(), so its blobs cannot be enumerated.',
    );
  }
  const identity = { ownerEntityId: from.ownerEntityId, timezone: from.timezone };
  const to = await create(identity);
  try {
    await assertNewStore(to, identity);
    for (const type of await from.listTypes()) await to.saveType(type);
    await copyRecords(from, to);
    for (const { fileId } of await listBlobs()) await to.putBlob(await from.getBlob(fileId));
    return to;
  } catch (err) {
    await to.close?.();
    throw err;
  }
}

/**
 * The one rule a target is held to: the store its adapter creates with
 * `identity` — that owner and timezone, no Record and no Type — on an
 * adapter that can write history. Blobs are content-addressed, so one
 * already there conflicts with nothing.
 */
async function assertNewStore(to: StackAdapter, identity: StackIdentity): Promise<void> {
  const refuse = (why: string) => {
    throw new InvalidAdapterError(`Cannot copy into the store create() returned: ${why}.`);
  };
  if (!to.importRecord) refuse('it has no importRecord(), so it cannot write history');
  if (to.ownerEntityId !== identity.ownerEntityId) {
    refuse(`it is owned by "${to.ownerEntityId}", not "${identity.ownerEntityId}"`);
  }
  if (to.timezone !== identity.timezone) {
    refuse(
      `its timezone is ${JSON.stringify(to.timezone)}, not ${JSON.stringify(identity.timezone)}`,
    );
  }
  if ((await to.queryRecords(resolveQuery({ ...EVERYTHING, limit: 1 }))).records.length) {
    refuse('it already holds Records');
  }
  if ((await to.listTypes()).length) refuse('it already holds Types');
}

async function copyRecords(from: StackAdapter, to: StackAdapter): Promise<void> {
  let cursor: string | undefined;
  do {
    const page = await from.queryRecords(resolveQuery({ ...EVERYTHING, cursor }));
    for (const record of page.records) {
      const [versions, journal] = await Promise.all([
        from.getVersions(record.id),
        from.getJournal(record.id),
      ]);
      await to.importRecord!(record, { versions, journal });
    }
    cursor = page.cursor ?? undefined;
  } while (cursor);
}
