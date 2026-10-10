/**
 * Content shapes for the reserved `_`-prefixed system types.
 */

import type { Grantee } from './associations.js';
import type { TypeId, BaseId, FileId, AppId, EntityId } from './ids.js';

/**
 * Content for _entity records: a stack-local profile card *about* a DID,
 * not the identity itself. `name`/`handle` are this owner's local labels
 * for that DID (the petname pattern), so two stacks holding different
 * names for the same DID is correct. See docs/spec/identity.md § Entity.
 */
export type EntityContent = {
  /**
   * The identity this profile is about. e.g. "did:key:z6Mk...". A binding,
   * not a value — an Actor's `subjectId` resolves through it to the name
   * this card carries, so it is unique per stack and immutable once set.
   * See docs/spec/identity.md § DID bindings.
   */
  did: string;
  /** Display name — human-friendly, not necessarily unique. May contain spaces and punctuation. e.g. "Jane Smith" */
  name: string;
  /**
   * Short, conventionally URL-safe label. e.g. "janesmith". A label, not a
   * key: duplicates are legitimate and `did` is what identifies this
   * profile. See docs/spec/identity.md § Entity.
   */
  handle?: string;
};

/** Content for _app records */
export type AppContent = {
  /**
   * The software this card is about, in reverse-DNS form — the value a
   * Record's `appId` is checked against. Distinct from the card Record's
   * own `appId`, which names whatever wrote the card (an admin console
   * registering a third-party app is the ordinary case, and the two differ
   * there). See docs/spec/identity.md § App.
   */
  appId: AppId;
  /** Display name of the app e.g. "My Notes App" */
  name: string;
  /** Semver string e.g. "1.0.0". `appId` is the machine-readable identity, so no handle is needed here. */
  version?: string;
  /**
   * The DID this app authenticates with, when it holds a key of its own —
   * what an Actor's `principalId` resolves to, and what a self-reported
   * `appId` is checked against. Absent for apps that ride their user's
   * identity. Unique and immutable: docs/spec/identity.md § DID bindings.
   */
  did?: string;
};

/** Content for _group records */
export type GroupContent = {
  /** Display name — human-friendly, not necessarily unique. May contain spaces and punctuation. e.g. "Jane's Book Club" */
  name: string;
  /**
   * Short, conventionally URL-safe label. e.g. "janes-book-club". A label,
   * not a key: duplicates are legitimate, and a group is addressed by
   * `stackUrl` when it has one and by its record id otherwise. See
   * docs/spec/identity.md § Group.
   */
  handle?: string;
  /** If present, this group owns a shared collaborative stack at this URL. Absent = permission-only group. */
  stackUrl?: string;
};

/**
 * Actions that can be granted via a _grant record. The array is the source
 * of truth — GrantAction is derived from it so runtime validation (see
 * Stack.grantType()) can't drift from the type.
 */
export const GRANT_ACTIONS = [
  'create',
  'read-own',
  'read-any',
  'update-own',
  'update-any',
  'delete-own',
  'delete-any',
] as const;

export type GrantAction = (typeof GRANT_ACTIONS)[number];

/**
 * Who a Grant reaches. `authenticated` is any authenticated entity —
 * narrower than a Record permission's `anyone`, which reaches anonymous
 * requesters too, so the two tiers deliberately share no word.
 * See docs/spec/access-control.md § Type-level grants.
 */
export type GrantGrantee = Grantee | { kind: 'authenticated' };

/**
 * What `Stack.grantType()` and `Stack.revokeType()` take beside the type they act
 * on — the type-level counterpart of the `AuthorityAssociation`
 * `grantAccess()` takes beside a record id.
 */
export type TypeGrant = {
  actions: GrantAction[];
  grantee: GrantGrantee;
};

/**
 * Content for _grant records: a TypeGrant pinned to the type family it
 * applies to — a bare baseId, never a versioned TypeId.
 */
export type GrantContent = TypeGrant & {
  baseId: BaseId;
};

/**
 * One type-level grant an app's manifest asks for. No grantee: the app's
 * own keys are who it reaches. See docs/spec/apps.md.
 */
export type InstallRequest = Omit<GrantContent, 'grantee'>;

/**
 * Content for _install records: what the owner approved of an app's
 * manifest, one live record per `appId`. See docs/spec/apps.md.
 */
export type InstallContent = {
  /**
   * The software this install is for. A binding: immutable, and unique
   * among installs, so one install answers for each app.
   */
  appId: AppId;
  name: string;
  version?: string;
  /**
   * Every type version the owner has approved for this app. The families
   * they name are claimed by this install and by no other.
   */
  defines: TypeId[];
  /** The grants each of the app's keys holds. */
  requests: InstallRequest[];
};

/** Content for _attachment records — one per upload, tracks file metadata. */
export type AttachmentContent = {
  /** Content-addressed file identifier (SHA-256 hex). */
  fileId: FileId;
  /** MIME type of the file. */
  mimeType: string;
  /** File size in bytes. */
  size: number;
  /** Original filename, if provided at upload time. */
  filename?: string;
};

/** Content for _config records — one singleton per stack, created on initialization. */
export type ConfigContent = {
  /**
   * DID of the stack owner. Immutable — see docs/spec.md § The `_config`
   * record for why ownership transfer isn't a field write.
   */
  entityId: EntityId;
  /**
   * IANA timezone string e.g. "America/New_York". Optional passthrough app
   * metadata — nothing in core reads it for behavior, and there is no
   * default. See docs/spec.md § The `_config` record.
   */
  timezone?: string;
};

/** Reserved system type IDs */
export const SYSTEM_TYPES = {
  ENTITY: '_entity',
  APP: '_app',
  GROUP: '_group',
  /** Creation-permission grants. See GrantContent. */
  GRANT: '_grant',
  /** Attachment metadata records. See AttachmentContent. */
  ATTACHMENT: '_attachment',
  /** Stack-level configuration singleton. See ConfigContent. */
  CONFIG: '_config',
  /** An owner's approval of an app's manifest. See InstallContent. */
  INSTALL: '_install',
} as const;
