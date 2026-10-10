/**
 * Association identity and edits
 * -------------------------------------------------------
 * When two associations are the same one, what a list of edits leaves
 * behind, and what it moved. Identity is asked by every layer that touches
 * an association — the no-op decision, the journal's delta, an adapter
 * applying edits, the feed — so they answer it with one comparison and
 * can never disagree. See docs/spec/data-model.md § Associations.
 */

import { StackBadRequestError } from '../errors.js';
import type {
  Association,
  AssociationChange,
  AssociationEdit,
  AuthorityAssociation,
  DataAssociation,
  Grantee,
  RelationshipTarget,
} from '../types/index.js';

/**
 * Association identity — what dissociate() matches and a repeat associate()
 * collides with; the SQLite adapter's primary key. An attachment's
 * `attachmentRecordId` annotates a reference rather than naming one, so it
 * is outside; a group grantee's `role` names a different set of people, so
 * it is inside. See docs/spec/data-model.md § Associations.
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
export function granteeEqual(a: Grantee, b: Grantee): boolean {
  if (!a || !b) return false;
  if (a.kind !== b.kind) return false;
  if (a.kind === 'entity' && b.kind === 'entity') return a.entityId === b.entityId;
  if (a.kind === 'group' && b.kind === 'group') {
    return a.groupId === b.groupId && a.role === b.role;
  }
  return false;
}

/** Structural equality per target arm — what dissociate() matches on. */
export function targetEqual(a: RelationshipTarget, b: RelationshipTarget): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'record' && b.kind === 'record') {
    return a.recordId === b.recordId && (a.stackUrl ?? '') === (b.stackUrl ?? '');
  }
  if (a.kind === 'entity' && b.kind === 'entity') return a.entityId === b.entityId;
  if (a.kind === 'external' && b.kind === 'external') return a.ns === b.ns && a.id === b.id;
  return false;
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
 * An association's identity alone, its annotation dropped — what a change
 * event reports for an association that's gone, as a `purged` frame names
 * a destroyed record without repeating its content.
 * See docs/spec/events.md § The event shape.
 */
function stripAssociationAnnotation(association: Association): Association {
  if (association.kind !== 'attachment') return association;
  const { attachmentRecordId: _attachmentRecordId, ...identity } = association;
  return identity as Association;
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
 * What a `changes.associations` list moves against a record's current set,
 * one tagged edit each. An entry matching an existing identity displaced it:
 * a `repoint`, carrying the prior association in full as `previous` — the
 * only place an overwritten `attachmentRecordId` survives.
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
      .map((association) => ({ op: 'remove', association })),
  );
}

/**
 * The two flat lists a change frame carries, derived from the tagged list.
 * The feed reports what is true now, so a `repoint` appears only under its
 * new value and a `remove` by identity alone — the prior state the journal
 * keeps has no place on a notification. The data half alone: `reshare` is
 * what announces an ACL move. See docs/spec/events.md § The event shape.
 */
export function feedAssociationDelta(changes: AssociationChange[]): {
  added: DataAssociation[];
  removed: DataAssociation[];
} {
  const added: DataAssociation[] = [];
  const removed: DataAssociation[] = [];
  for (const c of changes) {
    if (c.op === 'remove') {
      const identity = stripAssociationAnnotation(c.association);
      if (!isAuthorityAssociation(identity)) removed.push(identity);
    } else if (!isAuthorityAssociation(c.association)) {
      added.push(c.association);
    }
  }
  return { added, removed };
}

/**
 * An association edit list travels one surface: authority and data share
 * storage and a delta, and never share a call. Refused here so every
 * adapter inherits the same rule.
 * See docs/spec/access-control.md § Storage unifies; the API does not.
 */
export function assertOneSurface(changes: readonly AssociationEdit[]): void {
  const authority = changes.filter((c) => isAuthorityAssociation(c.association)).length;
  if (authority === 0 || authority === changes.length) return;
  throw new StackBadRequestError(
    'An association edit list carries authority or data, never both: permission and anyone ' +
      'elements travel on the permissions surface.',
  );
}

/**
 * The set a list of edits leaves behind: removes first, then adds, an add
 * landing on an identity already held in place. Adds naming one identity
 * collapse, last wins; an add outlives a remove of the same identity.
 * See docs/spec/adapters.md § Amending associations.
 */
export function applyAssociationEdits(
  current: Association[],
  changes: readonly AssociationEdit[],
): Association[] {
  let next = current.filter(
    (a) => !changes.some((c) => c.op === 'remove' && associationEqual(c.association, a)),
  );
  for (const c of changes) {
    if (c.op !== 'add') continue;
    next = next.some((a) => associationEqual(a, c.association))
      ? next.map((a) => (associationEqual(a, c.association) ? c.association : a))
      : [...next, c.association];
  }
  return next;
}

/**
 * The same op over every element of a list — what associate(),
 * dissociate(), grantAccess() and revokeAccess() hand to the amend verb
 * each is one half of.
 */
export function editsOf(op: 'add' | 'remove', associations: Association[]): AssociationEdit[] {
  return associations.map((association) => ({ op, association }));
}
