/**
 * What a write moved, and how a Record is presented
 * -------------------------------------------------------
 * Two jobs that share one question — what does this Record actually say?
 *
 * The write helpers answer it against a proposed write: whether a patch
 * moved content, and whether the ops a write reports bump its version.
 * The projections answer it against a reader: a soft-deleted Record is its
 * tombstone, and a journal entry names the ACL it moved only to a reader
 * who could have moved it.
 *
 * See docs/spec/events.md § The event shape and docs/spec/versioning.md
 * § The tombstone is literal.
 */

import { isAuthorityAssociation } from './associations/identity.js';
import type {
  AssociationChange,
  ChangeOp,
  RecordJournalEntry,
  StackRecord,
} from './types/index.js';

/**
 * The ops whose prior state the journal already carries in full, so a
 * snapshot would preserve nothing a restore could not otherwise reach.
 * See docs/spec/versioning.md § Version history.
 */
const NO_BUMP_OPS: ReadonlySet<ChangeOp> = new Set<ChangeOp>([
  'associate',
  'dissociate',
  'reshare',
  'reparent',
  'unlist',
  'list',
]);

/**
 * Whether a write's ops advance `version`/`updatedAt` at all. After the
 * no-bump set above, this is `patch` and the whole-record verbs.
 */
export function bumpsVersion(ops: ChangeOp[]): boolean {
  return ops.some((op) => !NO_BUMP_OPS.has(op));
}

/**
 * Whether a merge patch produced the content already held, compared by
 * serialization: a patch preserves the order of every key it does not name.
 * A pure reordering is the one false "change", costing an empty version
 * rather than a wrong answer.
 */
export function contentEqual(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * The tombstone a soft-deleted Record is presented as. `permissions` is
 * retained because it decides whether the caller may undelete; history is
 * exempt, which is why getVersions() still serves the content this
 * withholds. See docs/spec/versioning.md § The tombstone is literal.
 */
function tombstoneOf(record: StackRecord): StackRecord {
  return {
    id: record.id,
    typeId: record.typeId,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    version: record.version,
    content: {},
    ...(record.deletedAt !== undefined && { deletedAt: record.deletedAt }),
    ...(record.unlistedAt !== undefined && { unlistedAt: record.unlistedAt }),
    ...(record.permissions !== undefined && { permissions: record.permissions }),
  };
}

/** A soft-deleted Record presented as its tombstone; anything else untouched. */
export const presentDeleted = (record: StackRecord): StackRecord =>
  record.deletedAt ? tombstoneOf(record) : record;

/**
 * Whether a tagged edit moved an authority element, reading whichever half
 * of the pair carries one. The delta is one list across the partition, so
 * every consumer that serves one half alone asks this.
 */
function movesAuthority(change: AssociationChange): boolean {
  return isAuthorityAssociation(change.association);
}

/**
 * A journal entry as a reader who cannot reshare sees it: the authority
 * half of its delta dropped, the `reshare` op left standing, so the
 * entry still names *that* the ACL moved. Passing the mutate-surface gate
 * buys the record's content history, which is not a route to its sharing
 * graph. See docs/spec/journal.md § Reading it.
 */
export function withoutAuthorityChanges(entry: RecordJournalEntry): RecordJournalEntry {
  if (!entry.associations?.some(movesAuthority)) return entry;
  const data = entry.associations.filter((c) => !movesAuthority(c));
  const { associations: _authority, ...rest } = entry;
  return data.length ? { ...rest, associations: data } : (rest as RecordJournalEntry);
}
