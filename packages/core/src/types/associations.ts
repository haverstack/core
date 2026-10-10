/**
 * Associations: the edges a Record carries, authority and data alike,
 * and the change shapes that move them.
 */

import type { RecordId, FileId, EntityId } from './ids.js';

export type TagAssociation = {
  kind: 'tag';
  label: string;
};

/**
 * `attachmentRecordId` names the `_attachment` record whose upload
 * established this reference — annotation, not identity, since `fileId`
 * alone is what GC, the `referencesFileId` filter and file access ask
 * about. See docs/spec/attachments.md § Naming the upload a reference came from.
 */
export type AttachmentAssociation = {
  kind: 'attachment';
  label: string;
  fileId: FileId;
  attachmentRecordId?: RecordId;
};

/**
 * A Record in this stack, or in another one. `stackUrl` is what makes a
 * RecordId meaningful outside the stack that minted it — absent means this
 * stack. See docs/spec/data-model.md § Associations.
 */
export type RecordTarget = {
  kind: 'record';
  recordId: RecordId;
  stackUrl?: string;
};

/**
 * A "who" — a DID, which means the same thing in every stack. Group
 * rosters are the canonical use: membership names identities, not records.
 * See docs/spec/identity.md § Group.
 */
export type EntityTarget = {
  kind: 'entity';
  entityId: EntityId;
};

/**
 * Something outside the stack entirely. `ns` names the scheme that
 * interprets `id` — e.g. "atproto", "activitypub", "email", "url" — so an
 * app selects on it rather than sniffing the identifier.
 * See docs/spec/data-model.md § Relationship targets.
 */
export type ExternalTarget = {
  kind: 'external';
  ns: string;
  id: string;
};

/** What a relationship association points at. */
export type RelationshipTarget = RecordTarget | EntityTarget | ExternalTarget;

export type RelationshipAssociation = {
  kind: 'relationship';
  label: string;
  target: RelationshipTarget;
};

/**
 * A grant of access to the Record carrying it. The bit is the label, so
 * granting and revoking are a plain add and remove and the element's
 * identity carries its whole meaning. Its grantee shape is its own rather
 * than a `RelationshipTarget`: a target names no role and has no group
 * arm. See docs/spec/access-control.md § Record-level permissions.
 */
export type PermissionAssociation = {
  kind: 'permission';
  label: 'read' | 'write';
  grantee: Grantee;
};

/** An entity's standing within a `_group` Record's roster. `admin` implies `member` for ACL purposes. */
export type GroupRole = 'member' | 'admin';

/**
 * The grantee arms both permission layers share, spelled identically so a
 * value built for one is valid for the other. `role` is required — `member`
 * is the wider set, `admin` the narrower, matching the roster labels where
 * admin implies member. See docs/spec/access-control.md § Who a grant reaches.
 */
export type Grantee =
  | { kind: 'entity'; entityId: EntityId }
  | { kind: 'group'; groupId: RecordId; role: GroupRole };

/**
 * Reach to the world, spelled affirmatively: it names no grantee and
 * carries no bit beyond `read`, so no dropped field on a
 * `PermissionAssociation` can produce it.
 * See docs/spec/access-control.md § Record-level permissions.
 */
export type AnyoneAssociation = {
  kind: 'anyone';
  label: 'read';
};

/**
 * The authority half of the association table — what the `permissions`
 * field projects. See docs/spec/access-control.md § Record-level
 * permissions.
 */
export type AuthorityAssociation = PermissionAssociation | AnyoneAssociation;

/**
 * The data half — what the `associations` field projects, and the only
 * kinds `associate()`/`dissociate()` accept.
 * See docs/spec/data-model.md § Associations.
 */
export type DataAssociation = TagAssociation | AttachmentAssociation | RelationshipAssociation;

/**
 * Every edge a Record carries, authority and data alike. One shape, one
 * delta and one durability tier; the two halves stay separate call
 * surfaces because they carry different authority.
 * See docs/spec/access-control.md § Record-level permissions.
 */
export type Association = DataAssociation | AuthorityAssociation;

/**
 * One association a write moved, and what it moved from. Each inverse is
 * local to one element, so there is no join key to get wrong; `previous`
 * is carried in full, which is what makes a `repoint` undoable.
 * See docs/spec/journal.md § The entry.
 */
export type AssociationChange =
  | { op: 'add'; association: Association }
  | { op: 'repoint'; association: Association; previous: Association }
  | { op: 'remove'; association: Association };

/**
 * What a caller sends: the journal's shape without `repoint`, which the
 * journal records and no caller requests. See docs/spec/journal.md § The entry.
 */
export type AssociationEdit = Exclude<AssociationChange, { op: 'repoint' }>;

/**
 * The aspects of an existing record one mutate() call may move, in any
 * combination. Keys are read for presence: `unlisted: false` is a change,
 * an omitted key is untouched. Each key replaces its aspect whole except
 * `contentPatch`, which merges at the top level (`null` removes).
 * See docs/spec/data-model.md § Mutations.
 */
export type RecordChangeSet = {
  contentPatch?: Record<string, unknown | null>;
  parentId?: RecordId | null;
  permissions?: AuthorityAssociation[];
  associations?: DataAssociation[];
  unlisted?: boolean;
};

/** The keys of a change set, for presence checks that must not miss one. */
export const RECORD_CHANGE_SET_KEYS = [
  'contentPatch',
  'parentId',
  'permissions',
  'associations',
  'unlisted',
] as const satisfies readonly (keyof RecordChangeSet)[];
