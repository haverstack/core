/**
 * What a write moved, and how a Record is presented
 * -------------------------------------------------------
 * Two jobs that share one question — what does this Record actually say?
 *
 * The equality helpers answer it against a proposed write, so the no-op
 * decision and a change event's `ops` are the same comparison and can never
 * disagree. The projections answer it against a reader: a soft-deleted
 * Record is its tombstone, and a snapshot's `permissions` are owner-only
 * audit data.
 *
 * See docs/spec/events.md § The event shape and docs/spec/versioning.md
 * § The tombstone is literal.
 */

import { baseIdOf } from './schema.js';
import { StackQueryError } from './errors.js';
import { SYSTEM_TYPES, RECORD_CHANGE_KEYS } from './types.js';
import type {
  Association,
  ChangeOp,
  EntityId,
  Permission,
  RecordChanges,
  RecordVersion,
  RelationshipTarget,
  StackRecord,
} from './types.js';

/**
 * Association identity — what dissociate() matches and a second associate()
 * of the same reference is a repeat of. Matches the SQLite adapter's
 * association primary key (kind, label, file_id, related_scope, related_id,
 * related_ns, related_stack), which is why an attachment's
 * `attachmentRecordId` is absent here: it annotates a reference rather than
 * naming one. See docs/spec/data-model.md § Associations.
 */
export function associationEqual(a: Association, b: Association): boolean {
  if (a.kind !== b.kind || a.label !== b.label) return false;
  if (a.kind === 'attachment' && b.kind === 'attachment') return a.fileId === b.fileId;
  if (a.kind === 'relationship' && b.kind === 'relationship') {
    return targetEqual(a.target, b.target);
  }
  return true;
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

export function permissionEqual(a: Permission, b: Permission): boolean {
  if (a.access !== b.access) return false;
  if (a.access === 'public') return true;
  if (a.access === 'entity' && b.access === 'entity') {
    return a.entityId === b.entityId && a.read === b.read && a.write === b.write;
  }
  if (a.access === 'group' && b.access === 'group') {
    return a.groupId === b.groupId && a.role === b.role && a.read === b.read && a.write === b.write;
  }
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
  // aspects this call names, and reading them as absent would drop a
  // change the caller asked for.
  if (RECORD_CHANGE_KEYS.some((key) => changes[key] !== undefined)) return;
  throw new StackQueryError(
    'A change set names at least one of: ' + RECORD_CHANGE_KEYS.join(', ') + '.',
  );
}

/**
 * Which aspects a change set actually moves, against the record as it
 * stands — the no-op decision and the change event's `ops` are the same
 * comparison, so they can never disagree. A key naming the value a record
 * already holds contributes nothing.
 *
 * `merged` is the content the patch produces, computed once by the
 * caller that had to validate it anyway.
 * See docs/spec/events.md § The event shape.
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

  if (changes.permissions && !permissionsEqual(existing.permissions ?? [], changes.permissions)) {
    ops.push('permissions');
  }

  if (changes.associations) {
    const before = existing.associations ?? [];
    const after = changes.associations;
    if (after.some((a) => !before.some((b) => associationIdentical(a, b)))) ops.push('associate');
    if (before.some((b) => !after.some((a) => associationEqual(a, b)))) ops.push('dissociate');
  }

  if (changes.unlisted !== undefined && Boolean(existing.unlistedAt) !== changes.unlisted) {
    ops.push(changes.unlisted ? 'unlist' : 'list');
  }

  return ops;
}

/**
 * The change set narrowed to the aspects that actually moved. An adapter
 * is handed this rather than what the caller wrote, so restating an aspect
 * cannot rewrite it: `unlisted: true` on an already-unlisted record would
 * otherwise drag `unlistedAt` forward, moving the record's publish moment
 * with no op reporting it. It also keeps the adapter contract honest —
 * every key an adapter receives is one it must write.
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
 * Compared by serialization: content is JSON by construction — it round
 * trips through storage that way — and a patch preserves key order for
 * every field it does not name, so the encoding of an unchanged record is
 * stable. A reordering patch that changes nothing else is the one case
 * this reports as a change, which costs an empty version rather than a
 * wrong answer.
 */
export function contentEqual(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function permissionsEqual(a: Permission[], b: Permission[]): boolean {
  return a.length === b.length && a.every((p, i) => permissionEqual(p, b[i]));
}

/**
 * Ensures `creator` carries an `admin` relationship association, adding one
 * if it's not already present. Used to bootstrap a `_group` record's first
 * admin at create time.
 */
export function stampGroupAdmin(
  associations: Association[] | undefined,
  creator: EntityId,
): Association[] {
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
 * Drops a snapshot's `permissions` — owner-only audit data, never served
 * to a non-owner history reader. `entityId` (change attribution) stays.
 * See docs/spec/versioning.md § History access.
 */
export function stripVersionPermissions(version: RecordVersion): RecordVersion {
  if (version.permissions === undefined) return version;
  const { permissions: _permissions, ...rest } = version;
  return rest;
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
