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
import type { PlainQuery, StackAdapter, StackRecordAdapter, StackType } from '../types/index.js';

/** What a store is created with: the identity `_config` holds, as an adapter reports it. */
export type StackIdentity = Pick<StackRecordAdapter, 'ownerEntityId' | 'timezone'>;

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
  const identity = { ownerEntityId: from.ownerEntityId, timezone: from.timezone };
  const to = await create(identity);
  try {
    const types = await from.listTypes();
    await assertNewStore(to, identity, types);
    for (const type of types) await to.saveType(type);
    // Bytes before the Records that name them, as every upload writes them.
    for (const { fileId } of await listBlobs()) await to.putBlob(await from.getBlob(fileId));
    await copyRecords(from, to);
    return to;
  } catch (err) {
    // The failure that stopped the copy is the one to report.
    await to.close?.().catch(() => {});
    throw err;
  }
}

/**
 * The one rule a target is held to: a store with `identity` holding no
 * Record, on an adapter that can write history. Whatever is named by what
 * it is — a blob by its bytes, a Type by its `id` and `schemaHash` — may
 * already be there if it is the same; a Type under another schema is refused.
 */
async function assertNewStore(
  to: StackAdapter,
  identity: StackIdentity,
  types: StackType[],
): Promise<void> {
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
  const hashes = new Map(types.map((type) => [type.id, type.schemaHash]));
  for (const held of await to.listTypes()) {
    const hash = hashes.get(held.id);
    if (hash !== undefined && hash !== held.schemaHash) {
      refuse(`it holds Type "${held.id}" under another schema`);
    }
  }
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
