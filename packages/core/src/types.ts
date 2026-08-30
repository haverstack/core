/**
 * Stack — Core Type Definitions
 * -------------------------------------------------------
 * This file is the source of truth for all types in the
 * Stack library. No logic lives here — just shapes.
 */

// -------------------------------------------------------
// Identifiers
// -------------------------------------------------------

/**
 * Crockford base-32 encoded ID — time-sortable, unique within a stack.
 * Format: 9-char timestamp prefix + 3-char random suffix = 12 chars total.
 * Human-readable and URL-safe. Uniqueness is within-stack only;
 * cross-stack references must include a stackUrl to disambiguate.
 */
export type RecordId = string;

/** Namespaced, versioned type identifier e.g. "com.example.myapp/note@2" */
export type TypeId = string;

/** Opaque file identifier returned by putAttachment */
export type FileId = string;

/**
 * Reverse-DNS identifier for the software that wrote a Record, e.g.
 * "com.example.myapp" — not a RecordId. Self-reported and never a
 * permission input; `StackRecord.principalId` is the verified counterpart.
 * See docs/spec/identity.md § App.
 */
export type AppId = string;

/**
 * Identifies a "who" — a DID string, e.g. "did:key:z6Mk...". A
 * self-certifying identifier that means the same thing in every stack,
 * unlike a RecordId. did:key is the mandatory floor method (see did.ts).
 * See docs/spec/identity.md.
 */
export type EntityId = string;

// -------------------------------------------------------
// Associations
// -------------------------------------------------------

export type TagAssociation = {
  kind: 'tag';
  label: string;
};

export type AttachmentAssociation = {
  kind: 'attachment';
  label: string;
  fileId: FileId;
};

export type RelationshipAssociation = {
  kind: 'relationship';
  label: string;
  recordId: RecordId;
};

export type Association = TagAssociation | AttachmentAssociation | RelationshipAssociation;

// -------------------------------------------------------
// Permissions
// -------------------------------------------------------

/**
 * Grants of access to a Record. Absence of permissions (empty or undefined)
 * means private — readable only by the stack owner. Permissions are
 * declarative intent; enforcement is the API adapter's responsibility.
 */
export type Permission =
  | { access: 'public' }
  | { access: 'entity'; entityId: EntityId; read: boolean; write: boolean }
  | {
      access: 'group';
      groupId: RecordId;
      /** Restricts this entry to group admins. Absent = any member (member or admin). */
      role?: 'admin';
      read: boolean;
      write: boolean;
    };

// -------------------------------------------------------
// Records
// -------------------------------------------------------

export type StackRecord = {
  // Core — always present, managed by the library
  id: RecordId;
  typeId: TypeId;
  createdAt: Date;
  updatedAt: Date;
  content: Record<string, unknown>;
  version: number; // Increments on each write

  // Optional native fields
  parentId?: RecordId; // Parent record (hierarchy/folders)
  entityId?: EntityId; // Author entity, if different from stack owner
  appId?: AppId; // App that created this record — self-reported, see AppId
  /**
   * The authenticated principal behind the write, when it isn't the author
   * itself — a delegated app's own DID. Absent means the writer
   * authenticated as the author, so `appId` is an unverifiable self-report;
   * present means `appId` can be checked against the `_app` record naming
   * this DID. See docs/spec/identity.md § App.
   */
  principalId?: EntityId;
  /**
   * The subject that performed the mutation this version records — unlike
   * `entityId`, it moves with every write. Absent means an unscoped `Stack`
   * wrote it, which names no requester.
   * See docs/spec/data-model.md § Authorship and attribution.
   */
  updatedBy?: EntityId;
  /**
   * The authenticated principal behind that mutation, when it isn't the
   * subject — `principalId` is the same fact about the create.
   * See docs/spec/data-model.md § Authorship and attribution.
   */
  updatedVia?: EntityId;
  deletedAt?: Date; // Present if soft-deleted
  /**
   * Present when the record is withheld from enumeration — absent from
   * `query()` and the change feed by default, but still reachable by
   * `get()` for anyone who may read it. Orthogonal to `permissions`: it
   * says nothing about who may read the record, only whether its
   * existence is discoverable without already holding its ID. See
   * docs/spec/access-control.md § Unlisted records.
   */
  unlistedAt?: Date;
  permissions?: Permission[];
  associations?: Association[];
};

// -------------------------------------------------------
// Record versions
// -------------------------------------------------------

export type RecordVersion = {
  version: number;
  /** The record's typeId at the moment this version was snapshotted. */
  typeId: TypeId;
  content: Record<string, unknown>;
  updatedAt: Date;
  /**
   * The record's author, carried through from `record.entityId` — not the
   * entity that performed the change this version records.
   * See docs/spec/versioning.md § Version history.
   */
  entityId?: EntityId;
  /** Who performed the mutation that produced this version. */
  updatedBy?: EntityId;
  /** The principal behind that mutation, when it isn't `updatedBy`. */
  updatedVia?: EntityId;
  associations?: Association[];
  permissions?: Permission[];
};

// -------------------------------------------------------
// Types
// -------------------------------------------------------

export type ScalarFieldKind =
  | 'string'
  | 'number'
  | 'boolean'
  | 'date'
  | 'text' // Long-form string (e.g. markdown body)
  | 'record-ref' // Reference to another record by ID
  | 'file-ref'; // Reference to an attachment file ID (SHA-256 hex) — indexed, unlike a plain `string` fileId

export type ScalarFieldDef = {
  kind: ScalarFieldKind;
  required?: boolean;
};

export type ArrayFieldDef = {
  kind: 'array';
  items: FieldDef; // What's inside the array
  required?: boolean;
};

export type ObjectFieldDef = {
  kind: 'object';
  properties: TypeSchema; // Recursive schema for nested objects
  required?: boolean;
};

/**
 * A field definition in a Type schema. Supports scalars, arrays, and nested
 * objects. Arrays and nested objects are schema-validated on write but are
 * opaque to the query engine in v1 — only top-level scalar fields support
 * exact-match content filtering in queries.
 */
export type FieldDef = ScalarFieldDef | ArrayFieldDef | ObjectFieldDef;

export type TypeSchema = {
  [fieldName: string]: FieldDef;
};

export type StackType = {
  id: TypeId; // e.g. "com.example.myapp/note@2"
  baseId: string; // Derived from id by stripping version suffix, e.g. "com.example.myapp/note"
  version: number;
  name: string; // Human-readable label
  schema: TypeSchema;
  schemaHash: string; // SHA-256 of canonical (minified, alpha-sorted) schema
  migratesFrom?: TypeId; // e.g. "com.example.myapp/note@1"
  createdAt: Date;
};

// -------------------------------------------------------
// System type content shapes
// -------------------------------------------------------

/**
 * Content for _entity records: a stack-local profile card *about* a DID,
 * not the identity itself. `name`/`handle` are this owner's local labels
 * for that DID (the petname pattern), so two stacks holding different
 * names for the same DID is correct. See docs/spec/identity.md § Entity.
 */
export type EntityContent = {
  /**
   * The identity this profile is about. e.g. "did:key:z6Mk...". A binding,
   * not a value — a Record's `entityId` resolves through it to the name
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
   * The DID this app authenticates with, when it holds a key of its own.
   * Lets an attribution UI resolve a record's `principalId` to this card,
   * and a server check a self-reported `appId` against the principal that
   * wrote it. Absent for apps that ride their user's identity. Unique per
   * stack and immutable once set, like `appId` above — see
   * docs/spec/identity.md § DID bindings.
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
 * Stack.grant()) can't drift from the type.
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

/** Content for _grant records */
export type GrantContent = {
  /** Which record type the grant applies to. */
  typeId: TypeId;
  /** Which actions are permitted. */
  actions: GrantAction[];
  /**
   * Who the grant applies to — a DID. Mutually exclusive with
   * granteeGroupId. Both absent = default grant, applies to any
   * authenticated entity.
   */
  granteeEntityId?: EntityId;
  /**
   * A `_group` Record ID whose roster the grant applies to — any member or
   * admin qualifies. Mutually exclusive with granteeEntityId, and never
   * satisfies the principal half of a delegated request.
   * See docs/spec/access-control.md § Type-level grants.
   */
  granteeGroupId?: RecordId;
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
} as const;

// -------------------------------------------------------
// Queries
// -------------------------------------------------------

export type DateRange = {
  before?: Date;
  after?: Date;
};

export type RecordFilter = {
  // Native fields
  typeId?: TypeId | TypeId[];
  /**
   * Match every version of a type family — e.g. baseId: "com.example/note"
   * matches both "com.example/note@1" and "com.example/note@2" records.
   * Resolved against registered Types, not parsed from typeId strings, so
   * it works regardless of which versions happen to exist. Combined with
   * typeId (if both given) as an intersection.
   */
  baseId?: string | string[];
  parentId?: RecordId | null; // null = root records only
  appId?: AppId | AppId[];
  entityId?: EntityId | EntityId[];
  principalId?: EntityId | EntityId[];
  createdAt?: DateRange;
  updatedAt?: DateRange;

  // Association filters
  tags?: string[]; // Records that have ALL of these tags
  hasAttachment?: string; // Records with an attachment of this label
  relatedTo?: {
    recordId: RecordId;
    label?: string;
  };
  attachmentFileId?: FileId; // Records that reference this attachment file ID

  // Content fields — exact match on top-level keys (POST /query only)
  content?: Record<string, unknown>;

  // Full-text search (capability varies by adapter)
  search?: string;

  // Soft-deleted records are excluded by default
  includeDeleted?: boolean;

  /**
   * Unlisted records are excluded by default, like soft-deleted ones.
   * Owner-only under `ScopedStack` — enumeration standing rests on nothing
   * but ownership, so a grant or delegation never carries it. See
   * docs/spec/access-control.md § Unlisted records.
   */
  includeUnlisted?: boolean;
};

export type QuerySort = {
  field: 'createdAt' | 'updatedAt' | 'version';
  direction?: 'asc' | 'desc';
};

export type StackQuery = {
  filter?: RecordFilter;
  sort?: QuerySort;
  limit?: number;
  cursor?: string; // Opaque cursor for page-based pagination
  /**
   * Records are returned exactly as stored by default ("stored"). Pass
   * "latest" to apply the registered migration chain in memory before
   * returning — never written back. Throws StackMigrationError if any
   * matched record has no registered path to the latest version.
   */
  presentAt?: 'stored' | 'latest';
};

export type QueryResult = {
  records: StackRecord[];
  cursor: string | null;
  /**
   * Total count of matching records, ignoring pagination. `null` when the
   * count cannot be reported without leaking information across a
   * permission boundary — e.g. a permission-scoped query (see
   * `Stack.asEntity()`) never reports an unfiltered total, since that would
   * reveal the existence/cardinality of records the requester can't read.
   */
  total: number | null;
};

// -------------------------------------------------------
// Migrations
// -------------------------------------------------------

export type MigrationFn = (content: Record<string, unknown>) => Record<string, unknown>;

export type Migration = {
  from: TypeId;
  to: TypeId;
  migrate: MigrationFn;
};

// -------------------------------------------------------
// Adapter capabilities / Stack features
// -------------------------------------------------------

export type AdapterCapabilities = {
  fullTextSearch: boolean;
  /**
   * Required `true` for local/in-process adapters; wire adapters may
   * report `false`, driven by the server's discovery response.
   * Stack.query() throws StackQueryError rather than silently widening.
   * See docs/spec/adapters.md § Adapter capabilities.
   */
  contentFieldQuery: boolean;
  sortableFields: Array<QuerySort['field']>;
  /**
   * Maximum attachment upload size in bytes, or `null` if unbounded. Lets
   * apps pre-check and surface limits before burning an upload on a 413.
   */
  maxAttachmentBytes: number | null;
  /**
   * Maximum serialized size in bytes of a Record's content — a create body
   * or a merge patch — or `null` if unbounded. The counterpart to
   * maxAttachmentBytes for the JSON side of a write, which had no stated
   * ceiling anywhere despite the spec bounding every other resource
   * (validation depth, queryAllPages, GC grace).
   *
   * Local adapters declare `null`: nothing at the storage layer imposes
   * one, and a caller with in-process access to the database can spend its
   * own memory however it likes. A server declares its request-size limit
   * here so apps can pre-check rather than discover it as a 413.
   * See docs/spec/adapters.md § Adapter capabilities.
   */
  maxContentBytes: number | null;
};

/** What a Stack can do, as seen by app and plugin code. */
export type StackFeatures = AdapterCapabilities;

// -------------------------------------------------------
// Adapter interfaces
// -------------------------------------------------------

/**
 * Opt-in optimistic-concurrency precondition, accepted by every mutation
 * that bumps a record's version. On mismatch the adapter throws
 * StackVersionConflictError without applying anything. The check is atomic
 * inside the adapter's write, never a read-then-write. See
 * docs/spec/versioning.md § Optimistic concurrency (`ifVersion`).
 */
export type ExpectedVersionOptions = {
  expectedVersion?: number;
};

/**
 * Accepted by every mutating StackRecordAdapter method. The adapter
 * persists this prior-state snapshot as part of the SAME atomic write as
 * the mutation, so a crash between the two can't leave an orphan versions
 * row. Server-backed adapters (already atomic per-request) can ignore it.
 */
export type SnapshotOptions = {
  snapshot?: RecordVersion;
};

/**
 * Who is performing a mutation, stamped onto the record in the same write.
 * `ScopedStack` supplies it from the request's identities; a caller of
 * plain `Stack` supplies it only when reconstructing an attributed write.
 * See docs/spec/data-model.md § Authorship and attribution.
 */
export type ActorOptions = {
  updatedBy?: EntityId;
  updatedVia?: EntityId;
};

// -------------------------------------------------------
// Change events
// -------------------------------------------------------

/**
 * The coarse branch every subscriber makes, closed at four values. A
 * handler covering exactly these is complete, not merely adequate:
 * `changed` is an upsert signal carrying seven distinct verbs.
 * See docs/spec/events.md § The event shape.
 */
export type ChangeKind = 'created' | 'changed' | 'deleted' | 'purged';

/**
 * The precise verb behind a ChangeKind, for consumers that distinguish a
 * reshare from an edit. The list is the mutations that bump `version`,
 * plus create and hard delete.
 */
export type ChangeOp =
  | 'create'
  | 'update'
  | 'associate'
  | 'dissociate'
  | 'permissions'
  | 'migrate'
  | 'restore'
  | 'delete'
  | 'undelete'
  | 'hard-delete'
  /**
   * Emitted even though the record's post-change state (`unlistedAt` now
   * set) would otherwise be excluded by the same filter it announces —
   * subscribers who already know the record need telling to drop it. See
   * docs/spec/events.md § The unlisted transition.
   */
  | 'unlist'
  /** The publish moment — mechanically an upsert, like `undelete`. */
  | 'list';

/**
 * Who performed a change — never who authored the record. Absent from a
 * RecordChange entirely when unknown, which means a write by an unscoped
 * `Stack`: absence is a fact of its own and never stands in for the
 * author. See docs/spec/events.md § Attribution.
 */
export type ChangeActor = {
  /** The subject the change is attributed to. */
  entityId: EntityId;
  /** The principal behind it, when a delegated app acted for the subject. */
  principalId?: EntityId;
  /** Self-reported at create, never a trust input. See AppId. */
  appId?: AppId;
};

/**
 * One change to one record. The envelope describes the change; the record
 * describes the record, so nothing of the record's own provenance appears
 * here — a consumer that wants it asks for `record`.
 * See docs/spec/events.md § The event shape.
 */
export type RecordChange = {
  kind: ChangeKind;
  op: ChangeOp;
  recordId: RecordId;
  /** As stored at the moment of the change. */
  typeId: TypeId;
  /** The version this change produced; on `purged`, the version destroyed. */
  version: number;
  /** As persisted by this change; on `purged`, when the delete ran. */
  updatedAt: Date;
  parentId?: RecordId;
  actor?: ChangeActor;
  /**
   * The record as of this change — present only when asked for and
   * available, never required for correctness, and never on `purged`.
   * Shared with every other subscriber on this emission, so a handler that
   * needs to alter it copies first. See docs/spec/events.md § The event
   * shape.
   */
  record?: StackRecord;
  /** Resume cursor, minted by a server. Local changes carry none. */
  seq?: string;
};

/**
 * Applied by the emitter, exactly: a filtered subscription never receives
 * an event outside its filter, so filtering again is redundant rather than
 * defensive.
 */
export type ChangeFilter = {
  /** Matched by baseId, as grants are, so a version bump orphans nothing. */
  typeId?: TypeId | TypeId[];
  parentId?: RecordId | null;
  /** The record's author. Not the actor — see ChangeActor. */
  entityId?: EntityId;
  kinds?: ChangeKind[];
};

/** Ends a subscription. Safe to call more than once. */
export type Unsubscribe = () => void;

export type SubscribeOptions = {
  filter?: ChangeFilter;
  /** Ask the emitter to include `record`. Honored when it can; never assume it. */
  includeRecords?: boolean;
  /**
   * Receive events for unlisted records too. Owner-only under
   * `ScopedStack`, same authority as `RecordFilter.includeUnlisted` — the
   * feed excludes unlisted records by default so it never delivers more
   * than an equivalent `query()` would return. See
   * docs/spec/access-control.md § Unlisted records.
   */
  includeUnlisted?: boolean;
  /**
   * Where a throwing handler's error goes. Without one the error is
   * rethrown asynchronously rather than swallowed; either way it never
   * reaches the caller of the mutation that produced the event.
   */
  onError?: (err: unknown) => void;
  /**
   * A gap opened that resumption could not close: reconcile by query.
   * Never fires on a local stack, which has no gap to open.
   */
  onReset?: () => void;
};

/**
 * What a relay is asked for. The subscriber's options minus the ones only
 * a local emitter answers: a relay reports changes it is told about and
 * decides nothing, so there is no handler of its own to route errors from.
 * `onError` here is the relay's own trouble — a connection it could not
 * restore — and `onReset` the gap that leaves.
 * See docs/spec/events.md § Where events come from.
 */
export type SubscribeChangesOptions = {
  filter?: ChangeFilter;
  /** Resume from this cursor. A relay with none starts from the present. */
  since?: string;
  includeRecords?: boolean;
  /** See SubscribeOptions.includeUnlisted. */
  includeUnlisted?: boolean;
  onError?: (err: unknown) => void;
  onReset?: () => void;
};

/**
 * The record-storage half of an adapter: structured data, queries,
 * associations, versioning, type definitions, and stack identity.
 */
export interface StackRecordAdapter {
  readonly capabilities: AdapterCapabilities;

  /** DID of the stack owner. Set during adapter initialization. */
  readonly ownerEntityId: EntityId;
  /**
   * IANA timezone string for this stack, or undefined if never set.
   * Passthrough app metadata with no default — see docs/spec.md § The
   * `_config` record.
   */
  readonly timezone: string | undefined;

  // Records
  /**
   * Throws StackConflictError if `record.id` already exists — never a
   * silent overwrite. The check must be atomic with the write (a PK/unique
   * constraint or equivalent); Stack itself doesn't pre-check, so a raw
   * adapter that skips this enforces nothing.
   */
  createRecord(record: StackRecord): Promise<StackRecord>;
  getRecord(id: RecordId): Promise<StackRecord | null>;
  /**
   * Apply a content-only RFC 7396 merge patch: `null` removes a field,
   * omitted fields are retained. Bumps `version`/`updatedAt` in the same
   * write. Never touches `typeId` — a type change goes through
   * commitMigration() instead.
   */
  patchContent(
    id: RecordId,
    patch: Record<string, unknown | null>,
    opts?: ExpectedVersionOptions & SnapshotOptions & ActorOptions,
  ): Promise<StackRecord>;
  /**
   * Returns the record this call acted on: as it now stands after a soft
   * delete, and as it stood immediately before destruction after a hard
   * one — captured inside the same write, so nothing can observe or alter
   * it in between. Null when there was no record to delete, which is the
   * only case that mutates nothing.
   */
  deleteRecord(
    id: RecordId,
    opts?: { hard?: boolean } & ExpectedVersionOptions & SnapshotOptions & ActorOptions,
  ): Promise<StackRecord | null>;
  /** Reverse a soft delete. Returns the record as it now stands. */
  undeleteRecord(
    id: RecordId,
    opts?: ExpectedVersionOptions & SnapshotOptions & ActorOptions,
  ): Promise<StackRecord>;
  queryRecords(query: StackQuery): Promise<QueryResult>;

  // Associations
  associate(
    id: RecordId,
    association: Association,
    opts?: ExpectedVersionOptions & SnapshotOptions & ActorOptions,
  ): Promise<StackRecord>;
  dissociate(
    id: RecordId,
    association: Association,
    opts?: ExpectedVersionOptions & SnapshotOptions & ActorOptions,
  ): Promise<StackRecord>;

  /** Replace all permissions on a record. Bumps version internally. */
  setPermissions(
    id: RecordId,
    permissions: Permission[],
    opts?: ExpectedVersionOptions & SnapshotOptions & ActorOptions,
  ): Promise<StackRecord>;

  /**
   * Set or clear `unlistedAt`. Bumps version internally, like
   * setPermissions(). The caller (Stack.setUnlisted()) is responsible for
   * picking the `unlist`/`list` change op from the transition, since the
   * adapter has no opinion on eventing.
   */
  setUnlisted(
    id: RecordId,
    unlisted: boolean,
    opts?: ExpectedVersionOptions & SnapshotOptions & ActorOptions,
  ): Promise<StackRecord>;

  // Versions
  getVersions(id: RecordId): Promise<RecordVersion[]>;
  getVersion(id: RecordId, version: number): Promise<RecordVersion | null>;
  /**
   * Standalone snapshot write, outside of a mutation's own atomic path.
   * Mutating methods above take a `snapshot` option instead, so the
   * snapshot and the mutation land in one write — see SnapshotOptions.
   */
  saveVersion(id: RecordId, version: RecordVersion): Promise<void>;
  /**
   * Restore a record to a previous version's content (and associations,
   * when the snapshot has them). Never restores permissions. Bumps version
   * internally. Throws StackNotFoundError if the version doesn't exist.
   */
  restoreVersion(
    id: RecordId,
    version: number,
    opts?: ExpectedVersionOptions & SnapshotOptions & ActorOptions,
  ): Promise<StackRecord>;

  /**
   * Commit a migration: write new content under a new typeId in one step.
   * This is the only way a record's typeId changes after creation — used by
   * Stack.commitMigration() and Stack.migrateAll(); Stack.update() never
   * changes typeId as a side effect. Bumps version internally.
   */
  commitMigration(
    id: RecordId,
    toTypeId: TypeId,
    content: Record<string, unknown>,
    opts?: ExpectedVersionOptions & SnapshotOptions & ActorOptions,
  ): Promise<StackRecord>;

  // Types
  saveType(type: StackType): Promise<void>;
  getType(id: TypeId): Promise<StackType | null>;
  listTypes(): Promise<StackType[]>;

  /**
   * Atomically verify fileId is unreferenced, then hard-delete its
   * metadata records in the same adapter call, returning their ids.
   * Throws StackConflictError if still referenced. Optional —
   * Stack.deleteAttachment() has a non-atomic fallback. See
   * docs/spec/attachments.md § Deleting attachments.
   */
  deleteUnreferencedAttachmentRecords?(
    fileId: FileId,
    metadataTypeId: TypeId,
  ): Promise<StackRecord[]>;

  /**
   * Relay changes that originated elsewhere — the inverse direction from
   * `Stack`, which emits every change made through it. Optional, and
   * absent on every local adapter: exactly one process owns a stack's
   * storage, so locally there is no third party whose writes could have
   * been missed. See docs/spec/events.md § Where events come from.
   */
  subscribeChanges?(
    opts: SubscribeChangesOptions,
    handler: (change: RecordChange) => void,
  ): Promise<() => void>;

  // Lifecycle
  flush?(): Promise<void>;
  close?(): Promise<void>;
}

/** One stored blob, as reported by StackBlobAdapter.listFiles(). */
export type BlobFileInfo = {
  fileId: FileId;
  size: number;
  /** When the blob was written. Used to apply a GC grace period to fresh, not-yet-associated uploads. */
  modifiedAt: Date;
};

/**
 * The blob-storage half of an adapter. Handles raw binary data only;
 * attachment metadata lives on _attachment@1 records in the record adapter.
 */
export interface StackBlobAdapter {
  // Attachments — bytes storage only; metadata lives on _attachment@1 records
  putAttachment(data: Uint8Array): Promise<FileId>;
  getAttachment(fileId: FileId): Promise<Uint8Array>;
  deleteAttachment(fileId: FileId): Promise<void>;

  /**
   * Enumerate every blob currently in storage. Optional — without it,
   * garbage collection can't find bare-bytes orphans (bytes with no
   * metadata record at all). See docs/spec/attachments.md § Garbage
   * collection.
   */
  listFiles?(): Promise<BlobFileInfo[]>;

  // Lifecycle
  flush?(): Promise<void>;
  close?(): Promise<void>;
}

/**
 * A complete adapter: record storage and blob storage combined.
 * Pass this to Stack.create(). Build one with combineAdapters() when you
 * want different backends for records and blobs (e.g. SQLite + S3).
 */
export type StackAdapter = StackRecordAdapter &
  StackBlobAdapter & {
    /**
     * Store bytes and create the accompanying _attachment@1 record as one
     * atomic operation. Optional; implement only when bytes and records
     * live behind a single boundary (today: APIAdapter alone), and never
     * synthesized by combineAdapters(). A security boundary, not an
     * efficiency shortcut — see docs/spec/adapters.md § Interface split.
     */
    putAttachmentWithMetadata?(
      data: Uint8Array,
      mimeType: string,
      filename?: string,
      appId?: AppId,
    ): Promise<StackRecord>;
  };

/**
 * The two identities a token establishes. Both are always populated: on an
 * undelegated token they are the same DID, and spelling that out is what
 * keeps the mapping onto asEntity() mechanical.
 *
 *     stack.asEntity(session.principalId, { onBehalfOf: session.subjectId })
 *
 * See docs/spec/access-control.md § Delegation: principal and subject.
 */
export type TokenSession = {
  /** Who authenticated — the DID that proved key possession. Governs authority. */
  principalId: EntityId;
  /** Who the principal acts for. Governs attribution. Equal to principalId unless delegated. */
  subjectId: EntityId;
};

export type TokenInfo = TokenSession & {
  id: string;
  label?: string;
  createdAt: Date;
  expiresAt?: Date;
};

/**
 * Bearer-token issuance and lookup for server implementations — a
 * standalone interface, not a slot on StackAdapter. createToken() trusts
 * its caller: DID verification happens first, via the challenge-response
 * handshake. Tokens SHOULD be stored outside the portable stack file.
 * See docs/spec/wire-format.md § Authentication.
 *
 * `onBehalfOf` is the delegation binding, and no handshake can establish
 * it — proving key possession proves the principal and nothing about whom
 * it may act for. It is asserted by the owner out of band, which is safe
 * because effective authority is the intersection of both parties' grants.
 */
export interface StackTokenStore {
  createToken(
    principalId: EntityId,
    opts?: { onBehalfOf?: EntityId; label?: string; expiresAt?: Date },
  ): Promise<{
    id: string;
    token: string;
  }>;
  lookupToken(token: string): Promise<TokenSession | null>;
  listTokens(): Promise<TokenInfo[]>;
  revokeToken(id: string): Promise<void>;
}
