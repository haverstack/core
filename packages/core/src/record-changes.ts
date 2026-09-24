/**
 * What a write moved, and how a Record is presented
 * -------------------------------------------------------
 * Two jobs that share one question — what does this Record actually say?
 *
 * The equality helpers answer it against a proposed write, so the no-op
 * decision and a change event's `ops` are the same comparison and can never
 * disagree. The projections answer it against a reader: a soft-deleted
 * Record is its tombstone, and a journal entry names the ACL it moved
 * only to a reader who could have moved it.
 *
 * See docs/spec/events.md § The event shape and docs/spec/versioning.md
 * § The tombstone is literal.
 */

import { baseIdOf } from './schema.js';
import { StackQueryError } from './errors.js';
import { SYSTEM_TYPES, RECORD_CHANGE_KEYS } from './types.js';
import type {
  Association,
  AssociationChange,
  AuthorityAssociation,
  ChangeOp,
  DataAssociation,
  EntityId,
  PermissionGrantee,
  RecordChanges,
  RecordJournalEntry,
  RelationshipTarget,
  StackRecord,
} from './types.js';

/**
 * Association identity — what dissociate() matches and a second associate()
 * of the same reference is a repeat of. Matches the SQLite adapter's
 * association primary key (kind, label, file_id, related_scope, related_id,
 * related_ns, related_stack, related_role), which is why an attachment's
 * `attachmentRecordId` is absent here: it annotates a reference rather than
 * naming one. `related_role` is in both because member and admin name two
 * different sets of people, so two group grantees differing only by role
 * are two elements. See docs/spec/data-model.md § Associations.
 */
export function associationEqual(a: Association, b: Association): boolean {
  // Never "the same one": naming a malformed association is
  // validateAssociation()'s job, which this must reach without throwing.
  if (!a || !b) return false;
  if (a.kind !== b.kind || a.label !== b.label) return false;
  if (a.kind === 'attachment' && b.kind === 'attachment') return a.fileId === b.fileId;
  if (a.kind === 'relationship' && b.kind === 'relationship') {
    return targetEqual(a.target, b.target);
  }
  if (a.kind === 'permission' && b.kind === 'permission') {
    return granteeEqual(a.grantee, b.grantee);
  }
  return true;
}

/**
 * Structural equality per grantee arm. `role` is required, so there is no
 * absent-means-any spelling to normalize.
 */
export function granteeEqual(a: PermissionGrantee, b: PermissionGrantee): boolean {
  if (!a || !b) return false;
  if (a.kind !== b.kind) return false;
  if (a.kind === 'entity' && b.kind === 'entity') return a.entityId === b.entityId;
  if (a.kind === 'group' && b.kind === 'group') {
    return a.groupId === b.groupId && a.role === b.role;
  }
  return false;
}

/**
 * Whether an association carries authority rather than data — the partition
 * `StackRecord.permissions` and `StackRecord.associations` project, and the
 * line `associate()`/`dissociate()` refuse to cross.
 * See docs/spec/access-control.md § Record-level permissions.
 */
export function isAuthorityAssociation(a: Association): a is AuthorityAssociation {
  return a?.kind === 'permission' || a?.kind === 'anyone';
}

/**
 * One stored association set split into the two the record presents. An app
 * editing tags never sees the authority half, so it cannot drop it.
 */
export function partitionAssociations(associations: Association[]): {
  associations: DataAssociation[];
  permissions: AuthorityAssociation[];
} {
  return {
    associations: associations.filter((a): a is DataAssociation => !isAuthorityAssociation(a)),
    permissions: associations.filter(isAuthorityAssociation),
  };
}

/**
 * Identity plus every annotation outside it, so a write that only re-points
 * an attachment association's `attachmentRecordId` still counts as a
 * change. Identity alone decides which stored association a write lands on;
 * this decides whether it says anything new.
 */
export function associationIdentical(a: Association, b: Association): boolean {
  if (!associationEqual(a, b)) return false;
  if (a.kind === 'attachment' && b.kind === 'attachment') {
    return (a.attachmentRecordId ?? '') === (b.attachmentRecordId ?? '');
  }
  return true;
}

/**
 * An association's identity, stripped of every annotation outside it — an
 * attachment's `attachmentRecordId` dropped, everything else unchanged.
 * What a change event reports for an association that's gone: the same
 * thing a `purged` frame does for a destroyed record's content, naming
 * what happened without repeating a payload that's no longer current.
 * See docs/spec/events.md § The event shape.
 */
export function stripAssociationAnnotation(association: Association): Association {
  if (association.kind !== 'attachment') return association;
  const { attachmentRecordId: _attachmentRecordId, ...identity } = association;
  return identity as Association;
}

/**
 * What a `changes.associations` list moves against a record's current
 * associations, one tagged edit per association.
 *
 * An entry matching something already there by identity displaced it rather
 * than joining it, which is a `repoint`: the association is still on the
 * record and only its annotation moved, so no `remove` can describe it.
 * `previous` is the prior association in full, annotation included — the
 * only place an overwritten or removed `attachmentRecordId` survives.
 * See docs/spec/journal.md § The entry.
 */
export function associationDelta(before: Association[], after: Association[]): AssociationChange[] {
  const changes: AssociationChange[] = after
    .filter((a) => !before.some((b) => associationIdentical(a, b)))
    .map((association) => {
      const previous = before.find((b) => associationEqual(b, association));
      return previous
        ? ({ op: 'repoint', association, previous } as const)
        : ({ op: 'add', association } as const);
    });
  return changes.concat(
    before
      .filter((b) => !after.some((a) => associationEqual(a, b)))
      .map((previous) => ({ op: 'remove', previous })),
  );
}

/**
 * The two flat lists a change frame carries, derived from the tagged list.
 * The feed reports what is true now, so a `repoint` appears only under its
 * new value and a `remove` by identity alone — the prior state the journal
 * keeps has no place on a notification.
 */
export function feedAssociationDelta(changes: AssociationChange[]): {
  added: Association[];
  removed: Association[];
} {
  return {
    added: changes.filter((c) => c.op !== 'remove').map((c) => c.association),
    removed: changes
      .filter((c) => c.op === 'remove')
      .map((c) => stripAssociationAnnotation(c.previous)),
  };
}

/** Structural equality per target arm — what dissociate() matches on. */
export function targetEqual(a: RelationshipTarget, b: RelationshipTarget): boolean {
  if (a.scope !== b.scope) return false;
  if (a.scope === 'record' && b.scope === 'record') {
    return a.recordId === b.recordId && (a.stackUrl ?? '') === (b.stackUrl ?? '');
  }
  if (a.scope === 'entity' && b.scope === 'entity') return a.entityId === b.entityId;
  if (a.scope === 'external' && b.scope === 'external') return a.ns === b.ns && a.id === b.id;
  return false;
}

/**
 * A change set has to name at least one aspect. Refused rather than read
 * as a no-op: it addresses nothing, so there is nothing it could have
 * failed to satisfy, and every way of producing one is a caller bug —
 * typically a conditional that built an empty object.
 * See docs/spec/data-model.md § Mutations.
 */
export function assertNonEmptyChangeSet(changes: RecordChanges): void {
  // Presence, not truthiness: `unlisted: false` and `parentId: null` are
  // aspects this call names.
  if (RECORD_CHANGE_KEYS.some((key) => changes[key] !== undefined)) return;
  throw new StackQueryError(
    'A change set names at least one of: ' + RECORD_CHANGE_KEYS.join(', ') + '.',
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
  changes: RecordChanges,
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
    ops.push('permissions');
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
  'permissions',
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
const NO_PRECONDITION_KEYS: ReadonlySet<(typeof RECORD_CHANGE_KEYS)[number]> = new Set([
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
export function takesIfVersion(changes: RecordChanges): boolean {
  return RECORD_CHANGE_KEYS.some(
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
export function effectiveChanges(changes: RecordChanges, ops: ChangeOp[]): RecordChanges {
  const effective: RecordChanges = {};
  if (ops.includes('patch')) effective.contentPatch = changes.contentPatch;
  if (ops.includes('reparent')) effective.parentId = changes.parentId;
  if (ops.includes('permissions')) effective.permissions = changes.permissions;
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
export function contentEqual(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Bootstraps a `_group` record's first admin at create time. */
export function stampGroupAdmin(
  associations: DataAssociation[] | undefined,
  creator: EntityId,
): DataAssociation[] {
  const list = associations ?? [];
  const alreadyAdmin = list.some(
    (a) =>
      a.kind === 'relationship' &&
      a.label === 'admin' &&
      a.target.scope === 'entity' &&
      a.target.entityId === creator,
  );
  if (alreadyAdmin) return list;
  return [
    ...list,
    { kind: 'relationship', label: 'admin', target: { scope: 'entity', entityId: creator } },
  ];
}

/**
 * Whether a Record is a `_group`, in any of its type versions — the family
 * whose roster rules apply.
 */
export function isGroupRecord(record: StackRecord): boolean {
  return baseIdOf(record.typeId) === SYSTEM_TYPES.GROUP;
}

/**
 * The tombstone a soft-deleted Record is presented as. `permissions` is
 * retained because it decides whether the caller may undelete; history is
 * exempt, which is why getVersions() still serves the content this
 * withholds. See docs/spec/versioning.md § The tombstone is literal.
 */
export function tombstoneOf(record: StackRecord): StackRecord {
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
export function movesAuthority(change: AssociationChange): boolean {
  return isAuthorityAssociation(change.op === 'remove' ? change.previous : change.association);
}

/**
 * A journal entry as a reader who cannot reshare sees it: the authority
 * half of its delta dropped, the `permissions` op left standing, so the
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
