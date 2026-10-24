/**
 * Copying a stack
 * -------------------------------------------------------
 * One stack, read in full from one adapter and written in full to a new
 * store created with its identity: every Record (soft-deleted and unlisted
 * included) with its version snapshots and journal, every Type, and every
 * blob. Export, import and moving between storage engines are all this one
 * call, with a different source and a different kind of store to create.
 * Full trust, like any direct adapter access: authorship and history land
 * as recorded, which no write through Stack may do. What is garbage is left
 * to the target's own collection. See docs/spec/portability.md.
 */

import { InvalidAdapterError, StackNotFoundError } from '../errors.js';
import { baseIdOf, referencedFileIds } from '../schema.js';
import { resolveQuery } from '../query-validation.js';
import type { EntityId, FileId, PlainQuery, StackAdapter } from '../types/index.js';
import { SYSTEM_TYPES } from '../types/index.js';

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

const SYSTEM_BASE_IDS = new Set<string>(Object.values(SYSTEM_TYPES));

/**
 * Copy everything `from` holds into the store `create` makes with `from`'s
 * identity, and return that store, open. Not atomic: a failure closes the
 * store part-written, to be discarded rather than resumed.
 * See docs/spec/portability.md § Copying a stack.
 */
export async function copyStack(from: StackAdapter, create: CreateStore): Promise<StackAdapter> {
  const identity = { ownerEntityId: from.ownerEntityId, timezone: from.timezone };
  const to = await create(identity);
  try {
    await assertNewStore(to, identity);
    await copyInto(from, to);
    return to;
  } catch (err) {
    await to.close?.();
    throw err;
  }
}

/**
 * The one rule a target is held to: it is what creating a store with
 * `identity` produces — that owner and timezone, no Record, no Type but the
 * system ones — on an adapter that can write history.
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
  if ((await to.listTypes()).some((type) => !SYSTEM_BASE_IDS.has(type.baseId))) {
    refuse('it already holds Types of its own');
  }
}

async function copyInto(from: StackAdapter, to: StackAdapter): Promise<void> {
  const types = await from.listTypes();
  for (const type of types) await to.saveType(type);
  const schemas = new Map(types.map((type) => [type.id, type.schema]));

  // Without listBlobs(), the blobs a store holds are the ones its Records
  // name, as far as anything can enumerate them.
  const named = new Set<FileId>();
  let cursor: string | undefined;
  do {
    const page = await from.queryRecords(resolveQuery({ ...EVERYTHING, cursor }));
    for (const record of page.records) {
      const [versions, journal] = await Promise.all([
        from.getVersions(record.id),
        from.getJournal(record.id),
      ]);
      await to.importRecord!(record, { versions, journal });
      if (from.listBlobs) continue;
      if (baseIdOf(record.typeId) === SYSTEM_TYPES.ATTACHMENT) {
        named.add((record.content as { fileId: FileId }).fileId);
      }
      for (const fileId of referencedFileIds(record, schemas.get(record.typeId) ?? {})) {
        named.add(fileId);
      }
    }
    cursor = page.cursor ?? undefined;
  } while (cursor);

  const fileIds = from.listBlobs ? (await from.listBlobs()).map((blob) => blob.fileId) : named;
  for (const fileId of fileIds) {
    try {
      await to.putBlob(await from.getBlob(fileId));
    } catch (err) {
      // A reference whose bytes are gone stays dangling, as it was.
      if (!(err instanceof StackNotFoundError)) throw err;
    }
  }
}
