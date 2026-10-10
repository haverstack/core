/**
 * What a write moved, and how a Record is presented
 * -------------------------------------------------------
 * Two jobs that share one question — what does this Record actually say?
 *
 * The change-set helpers answer it against a proposed write, so the no-op
 * decision and a change event's `ops` are the same comparison and can never
 * disagree. The projections answer it against a reader: a soft-deleted
 * Record is its tombstone, and a journal entry names the ACL it moved
 * only to a reader who could have moved it.
 *
 * See docs/spec/events.md § The event shape and docs/spec/versioning.md
 * § The tombstone is literal.
 */

import { StackBadRequestError } from './errors.js';
import { associationDelta, isAuthorityAssociation } from './associations/identity.js';
import { RECORD_CHANGE_SET_KEYS } from './types/index.js';
import type {
  AssociationChange,
  ChangeOp,
  RecordChangeSet,
  RecordJournalEntry,
  StackRecord,
} from './types/index.js';

/**
 * A change set has to name at least one aspect. Refused rather than read
 * as a no-op: it addresses nothing, so there is nothing it could have
 * failed to satisfy, and every way of producing one is a caller bug —
 * typically a conditional that built an empty object.
 * See docs/spec/data-model.md § Mutations.
 */
export function assertNonEmptyChangeSet(changes: RecordChangeSet): void {
  // Presence, not truthiness: `unlisted: false` and `parentId: null` are
  // aspects this call names.
  if (RECORD_CHANGE_SET_KEYS.some((key) => changes[key] !== undefined)) return;
  throw new StackBadRequestError(
    'A change set names at least one of: ' + RECORD_CHANGE_SET_KEYS.join(', ') + '.',
  );
}

/**
 * Which aspects a change set actually moves, against the record as it
 * stands. A key naming the value a record already holds contributes
 * nothing. `merged` is the content the patch produces, computed once by the
 * caller that had to validate it anyway.
 */
export function changeSetOps(
  existing: StackRecord,
  changes: RecordChangeSet,
  merged: Record<string, unknown> | undefined,
): ChangeOp[] {
  const ops: ChangeOp[] = [];

  if (merged !== undefined && !contentEqual(existing.content, merged)) ops.push('patch');

  if (changes.parentId !== undefined && changes.parentId !== (existing.parentId ?? null)) {
    ops.push('reparent');
  }

  if (
    changes.permissions &&
    associationDelta(existing.permissions ?? [], changes.permissions).length > 0
  ) {
    ops.push('reshare');
  }

  if (changes.associations) {
    const delta = associationDelta(existing.associations ?? [], changes.associations);
    if (delta.some((c) => c.op !== 'remove')) ops.push('associate');
    if (delta.some((c) => c.op === 'remove')) ops.push('dissociate');
  }

  if (changes.unlisted !== undefined && Boolean(existing.unlistedAt) !== changes.unlisted) {
    ops.push(changes.unlisted ? 'unlist' : 'list');
  }

  return ops;
}

/**
 * The ops whose prior state the journal already carries in full, so a
 * snapshot would preserve nothing a restore could not otherwise reach. A
 * change set naming only these is a no-bump write.
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
 * Whether a change set's ops advance `version`/`updatedAt` at all. After the
 * no-bump set above, this is `patch` and the whole-record verbs.
 */
export function bumpsVersion(ops: ChangeOp[]): boolean {
  return ops.some((op) => !NO_BUMP_OPS.has(op));
}

/**
 * The keys that guard nothing, because none of them moves `version` — a
 * precondition on it would fence a write that the number it names cannot
 * describe. See docs/spec/versioning.md § Optimistic concurrency.
 */
const NO_PRECONDITION_KEYS: ReadonlySet<(typeof RECORD_CHANGE_SET_KEYS)[number]> = new Set([
  'associations',
  'permissions',
  'parentId',
  'unlisted',
]);

/**
 * Whether `ifVersion` applies to a change set. A set naming only keys from
 * the no-precondition list above carries none; any other aspect named
 * restores the guard over the whole call. Read off the keys the caller
 * wrote rather than the ops the set turns out to move, so a stale caller is
 * told its version is stale whatever its patch says.
 */
export function takesIfVersion(changes: RecordChangeSet): boolean {
  return RECORD_CHANGE_SET_KEYS.some(
    (key) => !NO_PRECONDITION_KEYS.has(key) && changes[key] !== undefined,
  );
}

/**
 * The change set narrowed to the aspects that actually moved. An adapter is
 * handed this rather than what the caller wrote, so restating an aspect
 * cannot rewrite it: `unlisted: true` on an already-unlisted record would
 * otherwise drag `unlistedAt` forward with no op reporting it. Every key an
 * adapter receives is one it must write.
 */
export function effectiveChanges(changes: RecordChangeSet, ops: ChangeOp[]): RecordChangeSet {
  const effective: RecordChangeSet = {};
  if (ops.includes('patch')) effective.contentPatch = changes.contentPatch;
  if (ops.includes('reparent')) effective.parentId = changes.parentId;
  if (ops.includes('reshare')) effective.permissions = changes.permissions;
  if (ops.includes('associate') || ops.includes('dissociate')) {
    effective.associations = changes.associations;
  }
  if (ops.includes('unlist') || ops.includes('list')) effective.unlisted = changes.unlisted;
  return effective;
}

/**
 * Whether a merge patch produced the content the record already held.
 * Compared by serialization: content is JSON by construction and a patch
 * preserves key order for every field it does not name, so an unchanged
 * record encodes stably. A reordering patch that changes nothing else is
 * the one case this reports as a change, costing an empty version rather
 * than a wrong answer.
 */
function contentEqual(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
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
