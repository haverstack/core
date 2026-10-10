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

/** A type family: a TypeId without its version, e.g. "com.example.myapp/note" */
export type BaseId = string;

/** Opaque file identifier returned by putBlob() */
export type FileId = string;

/**
 * Reverse-DNS identifier for the software that wrote a Record, e.g.
 * "com.example.myapp" — not a RecordId. Self-reported and never a
 * permission input; `StackRecord.createdBy.principalId` is the verified
 * counterpart.
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

/**
 * Who did something, and through which principal. `subjectId` is who the
 * act is attributed to; `principalId` is who authenticated, present only
 * when it differs — a delegated app acting for its user. `Stack` stores
 * a `principalId` equal to `subjectId` as absent, so the two spellings of
 * "acted as itself" never diverge. See docs/spec/data-model.md § Actor.
 */
export type Actor = {
  subjectId: EntityId;
  principalId?: EntityId;
};

// -------------------------------------------------------
// Associations
// -------------------------------------------------------

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
  /**
   * Ordinal of the snapshot history, not a count of changes: associations,
   * permissions, parent and listing moves leave it alone. See
   * docs/spec/versioning.md § Version history.
   */
  version: number;

  // Optional native fields
  parentId?: RecordId; // Parent record (hierarchy/folders)
  appId?: AppId; // App that created this record — self-reported, see AppId
  /**
   * The record's author, stamped once by the create. A `principalId` here
   * is what lets `appId` be checked against the `_app` record naming that
   * DID; without one, `appId` is an unverifiable self-report.
   * See docs/spec/data-model.md § Authorship and attribution.
   */
  createdBy?: Actor;
  /**
   * Who performed the mutation this version records — unlike `createdBy`,
   * it moves with every write. Absent means an unscoped `Stack` wrote it,
   * which names no requester.
   * See docs/spec/data-model.md § Authorship and attribution.
   */
  updatedBy?: Actor;
  deletedAt?: Date; // Present if soft-deleted
  /**
   * Present when the record is withheld from enumeration: absent from
   * `query()` and the change feed by default, but reachable by `get()` for
   * anyone who may read it. Says nothing about who that is.
   * See docs/spec/unlisted.md.
   */
  unlistedAt?: Date;
  /**
   * Who reaches this Record, projected from the association table's
   * authority kinds. Absent or empty means private — readable only by the
   * stack owner. Declarative intent; enforcement is `ScopedStack`'s.
   * See docs/spec/access-control.md § Record-level permissions.
   */
  permissions?: AuthorityAssociation[];
  associations?: DataAssociation[];
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
   * The record's author, carried through from `record.createdBy` — not the
   * actor of the change this version records.
   * See docs/spec/versioning.md § Version history.
   */
  createdBy?: Actor;
  /** Who performed the mutation that produced this version. */
  updatedBy?: Actor;
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
  | 'file-ref' // Reference to an attachment file ID (SHA-256 hex) — indexed, unlike a plain `string` fileId
  | 'enum'; // One of a declared set of strings

/**
 * `values` is a non-empty, duplicate-free list of the strings the field may
 * hold. See docs/spec/data-model.md § Types.
 */
export type EnumFieldDef = {
  kind: 'enum';
  values: string[];
  required?: boolean;
};

export type ScalarFieldDef =
  | EnumFieldDef
  | { kind: Exclude<ScalarFieldKind, 'enum'>; required?: boolean };

/**
 * A list. `open: true` leaves its elements unvalidated,
 * which is how a heterogeneous or null-bearing list is spelled. Opacity is
 * declared rather than inferred from a missing `items`, so a schema that
 * forgets to describe its elements is a type error rather than a silently
 * unchecked field. See docs/spec/data-model.md § Undeclared content fields.
 */
export type ArrayFieldDef =
  | { kind: 'array'; items: FieldDef; open?: false; required?: boolean }
  | { kind: 'array'; open: true; items?: undefined; required?: boolean };

/**
 * An object. `open: true` leaves its keys unvalidated,
 * which is the one way to store a shape a schema does not describe. Same
 * reason as ArrayFieldDef for making it a declaration rather than an
 * omission. See docs/spec/data-model.md § Undeclared content fields.
 */
export type ObjectFieldDef =
  | { kind: 'object'; properties: TypeSchema; open?: false; required?: boolean }
  | { kind: 'object'; open: true; properties?: undefined; required?: boolean };

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
  baseId: BaseId; // Derived from id by stripping version suffix, e.g. "com.example.myapp/note"
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

/** The metadata an upload's `_attachment@1` record carries beside its bytes. */
export type PutAttachmentOptions = {
  mimeType: string;
  filename?: string;
  /** Attribution for the metadata record, as create()'s `appId`. */
  appId?: AppId;
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

// -------------------------------------------------------
// Queries
// -------------------------------------------------------

/**
 * A target pattern in `RecordFilter.relatedTo` — the association shape with
 * the parts a query may leave open: an `external` target without `id`
 * matches its whole namespace.
 */
export type RelationshipTargetPattern =
  | { kind: 'record'; recordId: RecordId; stackUrl?: string }
  | { kind: 'entity'; entityId: EntityId }
  | { kind: 'external'; ns: string; id?: string };

/**
 * A relationship query names a label, a target, or both — never neither.
 * "Carries any relationship at all" is deliberately not expressible, in
 * line with `tags` and `attachment`, which likewise have no match-any
 * form. See docs/spec/data-model.md § Filter.
 */
export type RelatedToFilter =
  | { label: string; target?: RelationshipTargetPattern }
  | { label?: string; target: RelationshipTargetPattern };

/**
 * An attachment query names a label, a file, or both — never neither —
 * and both halves together match one association. See
 * docs/spec/data-model.md § Filter.
 */
export type AttachmentFilter =
  | { label: string; fileId?: FileId }
  | { label?: string; fileId: FileId };

export type DateRange = {
  before?: Date;
  after?: Date;
};

export type RecordFilter = {
  // Native fields
  typeId?: TypeId | TypeId[];
  /**
   * Match every version of a type family, resolved against registered
   * Types rather than parsed from typeId strings. Intersects with `typeId`
   * when both are given. A value carrying an `@version` suffix is refused
   * with StackValidationError.
   */
  baseId?: BaseId | BaseId[];
  parentId?: RecordId | null; // null = root records only
  appId?: AppId | AppId[];
  /** Matches the record's author — never the latest actor, which isn't filterable. */
  createdBy?: {
    subjectId?: EntityId | EntityId[];
    principalId?: EntityId | EntityId[];
  };
  createdAt?: DateRange;
  updatedAt?: DateRange;

  // Association filters
  tags?: string[]; // Records that have ALL of these tags
  /** Records carrying a matching attachment association. See docs/spec/data-model.md § Filter. */
  attachment?: AttachmentFilter;
  /**
   * Records carrying a matching relationship association. Either half may
   * be given alone and each is a pattern: a bare `label` matches every
   * target under it, and an `external` target with no `id` matches the
   * whole namespace. An absent `stackUrl` on a `record` target matches
   * only local targets. See docs/spec/data-model.md § Filter.
   */
  relatedTo?: RelatedToFilter;
  /**
   * Records that reference this file, through an attachment association
   * or a top-level `file-ref` content field — the question GC and
   * `deleteAttachment()` ask. See docs/spec/attachments.md § Deleting attachments.
   */
  referencesFileId?: FileId;

  /**
   * Exact match on content fields, keyed by a dot-separated path
   * (`'emails.value'`); an array along the path matches element-wise. A
   * multi-segment key needs `filter.content: 'path'`. POST /records/query
   * only. See docs/spec/data-model.md § Filter.
   */
  content?: Record<string, unknown>;

  /**
   * Paths that must hold a non-null value — the question `content` cannot
   * ask. Element-wise like `content`. Needs `filter.contentPresent`.
   * POST /records/query only. See docs/spec/data-model.md § Filter.
   */
  contentPresent?: string[];

  // Full-text search (capability varies by adapter)
  search?: string;

  // Soft-deleted records are excluded by default
  includeDeleted?: boolean;

  /**
   * Unlisted records are excluded by default, like soft-deleted ones.
   * Owner-only under `ScopedStack` — enumeration standing rests on nothing
   * but ownership, so a grant or delegation never carries it. See
   * docs/spec/unlisted.md.
   */
  includeUnlisted?: boolean;
};

/**
 * The Record columns every adapter stores natively, and can order by. The
 * array is the source of truth, so the runtime checks that narrow a wire
 * value or a cursor to this set can't drift from NativeSortField.
 */
export const NATIVE_SORT_FIELDS = ['createdAt', 'updatedAt', 'version'] as const;

export type NativeSortField = (typeof NATIVE_SORT_FIELDS)[number];

/**
 * Order by a native column or a top-level content field — two members, so
 * a content field named `version` stays distinct from the native column.
 * `direction` defaults to `asc`; a query with no sort is `createdAt`,
 * newest first. See docs/spec/data-model.md § Sorting by a content field.
 */
export type QuerySort =
  | { field: NativeSortField; contentField?: never; direction?: 'asc' | 'desc' }
  | { field?: never; contentField: string; direction?: 'asc' | 'desc' };

export type StackQuery = {
  filter?: RecordFilter;
  sort?: QuerySort;
  limit?: number;
  cursor?: string; // Opaque cursor for page-based pagination
  /**
   * "stored" (the default) returns records as stored; "latest" applies the
   * migration chain in memory, never written back. Throws
   * StackMigrationError if a matched record has no path to the latest.
   */
  presentAt?: 'stored' | 'latest';
};

/**
 * A page of results and where the next one resumes. There is no count of
 * the whole match: see docs/spec/data-model.md § Sorting and pagination.
 */
export type QueryResult = {
  records: StackRecord[];
  cursor: string | null;
};

// -------------------------------------------------------
// Stack capabilities
// -------------------------------------------------------

/**
 * How far into `content` a filter key may reach. The rungs nest, so they
 * are one ordered value rather than booleans that can spell an impossible
 * state. An unrecognized value reads as `'none'`: a refusal is recoverable,
 * an unfiltered superset passed off as filtered is not.
 * See docs/spec/adapters.md § Adapter capabilities.
 */
export type ContentFilterReach =
  /** No `filter.content` and no `filter.contentPresent` at all. */
  | 'none'
  /** Single-segment field names only (`'did'`). */
  | 'field'
  /** Multi-segment paths too (`'emails.value'`). */
  | 'path';

/**
 * What a Stack — and the adapter under it — honors. Every `filter`/`sort`
 * entry is named for the query key it gates, so the capability a query
 * needs is derivable from the query. `limits` are numbers to pre-check
 * against, not features. See docs/spec/adapters.md § Adapter capabilities.
 */
export type StackCapabilities = {
  filter: {
    /**
     * Required `'path'` for local/in-process adapters; a wire adapter may
     * report a shallower rung, driven by the server's discovery response.
     * Stack.query() throws StackBadRequestError rather than silently widening.
     */
    content: ContentFilterReach;
    /**
     * Whether `filter.contentPresent` is honored. Beside the reach ladder,
     * not on it: matching a value promises nothing about answering whether
     * one is there. Meaningful only where `content` is not `'none'`.
     */
    contentPresent: boolean;
    /**
     * Whether `filter.search` is honored. Not a rung on the ladder: a
     * full-text index is a different mechanism from field matching, and
     * neither implies the other. Local adapters may decline it.
     */
    search: boolean;
  };
  sort: {
    /** Which native columns this adapter can order by; see NativeSortField. */
    fields: NativeSortField[];
    /**
     * Whether `sort.contentField` is honored. A boolean rather than names
     * in `fields`: an adapter that sorts by content indexes every top-level
     * scalar. Independent of `filter.content`.
     */
    contentField: boolean;
  };
  /**
   * Ceilings a client can check before spending a request; the server's
   * own limit stays authoritative. `null` means this client cannot
   * pre-check, not that nothing is enforced — local adapters declare it.
   * See docs/spec/adapters.md § Adapter capabilities.
   */
  limits: {
    /** Maximum attachment upload size in bytes. */
    attachmentBytes: number | null;
    /**
     * Maximum serialized size in bytes of a Record's content — a create
     * body or a merge patch. Stack.create()/Stack.mutate() pre-check
     * against it and throw StackPayloadTooLargeError before sending.
     */
    contentBytes: number | null;
  };
};

/**
 * A capability a query can be refused for, as its path into
 * StackCapabilities — the same name the spec and a discovery response
 * use, so an error says which key to look at. `limits` never appears: a
 * ceiling is not something a query can lack.
 */
export type MissingCapability =
  | 'filter.content'
  | 'filter.contentPresent'
  | 'filter.search'
  | 'sort.fields'
  | 'sort.contentField';

// -------------------------------------------------------
// Adapter interfaces
// -------------------------------------------------------

/**
 * Opt-in optimistic-concurrency precondition. On mismatch the mutation
 * throws StackVersionConflictError and changes nothing; an adapter checks
 * it atomically inside its write. See docs/spec/versioning.md § Optimistic
 * concurrency (`ifVersion`).
 */
export type IfVersionOptions = {
  ifVersion?: number;
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
 * Whether a mutateRecord() call advances `version`/`updatedAt`. `Stack`
 * computes it from what the change set moves; absent means `true`.
 * See docs/spec/versioning.md § Version history.
 */
export type BumpVersionOptions = {
  bumpsVersion?: boolean;
};

/**
 * Who is performing a mutation, stamped onto the record in the same write.
 * `ScopedStack` supplies it from the request's identities; a caller of
 * plain `Stack` supplies it only when reconstructing an attributed write.
 * See docs/spec/data-model.md § Authorship and attribution.
 */
export type ActorOptions = {
  actor?: Actor;
};

/**
 * The part of a change the record cannot report once the write has
 * landed: which aspects moved, who moved them, and what an association
 * mutation displaced. The adapter stamps the rest of the entry from the
 * row it just wrote, so the two never drift. See docs/spec/journal.md.
 */
export type JournalEntryInput = {
  ops: ChangeOp[];
  kind: ChangeKind;
  actor?: ChangeActor;
  /** The container a move took the record out of, `null` for the root. */
  previousParentId?: RecordId | null;
  /**
   * What an association mutation moved, one tagged edit per association,
   * with `previous` beside whatever displaced it.
   * See docs/spec/journal.md § The entry.
   */
  associations?: AssociationChange[];
};

/**
 * One durable entry in a record's change journal. Envelope only — content
 * lives on a RecordVersion. See docs/spec/journal.md § Ordering for why
 * `seq` is the only ordering.
 */
export type RecordJournalEntry = JournalEntryInput & {
  seq: number;
  /** When the entry was appended — not the record's `updatedAt`, which an association change leaves alone. */
  at: Date;
  /** The version this change produced — unchanged on an op that doesn't bump; see ChangeOp. */
  version: number;
  typeId: TypeId;
  /** Where the record sat after the change, absent for the root. */
  parentId?: RecordId;
};

/**
 * Accepted by every mutating StackRecordAdapter method. The adapter
 * appends the entry, allocating its `seq`, inside the SAME write as the
 * mutation, so a crash cannot leave a change unjournaled.
 */
export type JournalOptions = {
  journal?: JournalEntryInput;
};

/**
 * What every mutating StackRecordAdapter method that bumps `version` takes.
 * mutateRecord() adds BumpVersionOptions and deleteRecord() adds `purge`.
 */
export type MutateOptions = IfVersionOptions & SnapshotOptions & ActorOptions & JournalOptions;

/** Window into a record's journal. Omitting both reads the whole log, oldest first. */
export type JournalQuery = {
  /** Entries after this seq, exclusive. */
  afterSeq?: number;
  limit?: number;
};

/**
 * Window into a record's version history. Newest first, the reverse of
 * JournalQuery; omitting both reads every version.
 * See docs/spec/versioning.md § Version history.
 */
export type VersionsQuery = {
  /** Versions strictly older than this, exclusive. */
  beforeVersion?: number;
  limit?: number;
};

// -------------------------------------------------------
// Change events
// -------------------------------------------------------

/**
 * The coarse branch every subscriber makes, closed at four values. A
 * handler covering exactly these is complete, not merely adequate:
 * `changed` is an upsert signal carrying nine distinct verbs.
 * See docs/spec/events.md § The event shape.
 */
export type ChangeKind = 'created' | 'changed' | 'removed' | 'purged';

/**
 * The precise verb behind a ChangeKind, for consumers that distinguish a
 * reshare from an edit. Each is named after the call that produced it; see
 * docs/spec/events.md § The event shape for the three that aren't a method
 * name. `associate`, `dissociate`, `reshare`, `reparent`, `unlist` and
 * `list` don't bump; see docs/spec/versioning.md § Version history.
 */
export type ChangeOp =
  | 'create'
  | 'patch'
  | 'associate'
  | 'dissociate'
  | 'reshare'
  | 'migrate'
  | 'restore'
  | 'delete'
  | 'undelete'
  | 'purge'
  /**
   * Emitted even though the record's post-change state (`unlistedAt` now
   * set) would otherwise be excluded by the same filter it announces —
   * subscribers who already know the record need telling to drop it. See
   * docs/spec/events.md § The unlisted transition.
   */
  | 'unlist'
  /** The publish moment — mechanically an upsert, like `undelete`. */
  | 'list'
  /**
   * A move between containers. Matched by a `parentId` filter naming
   * *either* side of the move, so a subscriber watching the old container
   * learns the record left it — the record's post-change state alone
   * would answer only for the destination. See docs/spec/events.md
   * § The reparent transition.
   */
  | 'reparent';

/**
 * Who performed a change — never who authored the record. Absent from a
 * RecordChange entirely when unknown, which means a write by an unscoped
 * `Stack`: absence is a fact of its own and never stands in for the
 * author. See docs/spec/events.md § Attribution.
 */
export type ChangeActor = Actor & {
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
  /**
   * Every aspect this version moved, diffed against prior state rather
   * than read off the request. Never empty; multi-entry only for mutate().
   * See docs/spec/events.md § The event shape.
   */
  ops: ChangeOp[];
  recordId: RecordId;
  /** As stored at the moment of the change. */
  typeId: TypeId;
  /**
   * The version this change produced; on `purged`, the version destroyed.
   * Unchanged from the record's prior version on every op that doesn't
   * bump — see ChangeOp.
   */
  version: number;
  /**
   * As persisted by this change; on `purged`, when the delete ran.
   * Unchanged from the record's prior `updatedAt` on every op that
   * doesn't bump.
   */
  updatedAt: Date;
  parentId?: RecordId;
  actor?: ChangeActor;
  /**
   * Associations now present that weren't before — current annotation
   * included, so a re-point appears here under its new
   * `attachmentRecordId`. Present whenever `ops` includes `associate`, on
   * the same "as of this change" convention as every other field here.
   */
  associationsAdded?: DataAssociation[];
  /**
   * Associations no longer present, identity only — kind and label, plus
   * `fileId` for an attachment — present whenever `ops` includes
   * `dissociate`. An attachment's `attachmentRecordId` is never repeated
   * here, the same way a `purged` frame never carries what it destroyed.
   */
  associationsRemoved?: DataAssociation[];
  /**
   * The record as of this change — present only when asked for and
   * available, never on `purged`. Shared with every other subscriber on
   * this emission, so a handler that needs to alter it copies first.
   */
  record?: StackRecord;
  /**
   * Resume cursor, minted by a server. Local changes carry none, this
   * stack's own writes included — so a consumer holding a cursor keeps
   * the last one that was present rather than the last change's.
   */
  cursor?: string;
};

/**
 * Applied by the emitter, exactly: a filtered subscription never receives
 * an event outside its filter, so filtering again is redundant rather than
 * defensive. Every key means what it means on `RecordFilter`, so one value
 * can drive both `query()` and `subscribe()`. See docs/spec/events.md
 * § Subscribing.
 */
export type ChangeFilter = Pick<RecordFilter, 'typeId' | 'baseId' | 'parentId' | 'createdBy'> & {
  kinds?: ChangeKind[];
};

/** Ends a subscription. Safe to call more than once. */
export type Unsubscribe = () => void;

/**
 * What a subscriber asks for, and what `Stack` forwards unchanged to an
 * adapter's `subscribeChanges()` relay — the relay honors every key.
 * See docs/spec/events.md § Subscribing and § Where events come from.
 */
export type SubscribeOptions = {
  filter?: ChangeFilter;
  /** Ask the emitter to include `record`. Honored when it can; never assume it. */
  includeRecords?: boolean;
  /**
   * Receive events for unlisted records too. Owner-only under
   * `ScopedStack`, same authority as `RecordFilter.includeUnlisted`.
   * See docs/spec/unlisted.md.
   */
  includeUnlisted?: boolean;
  /**
   * Resume from this cursor — the last `cursor` that was *present* on a
   * delivered `RecordChange`. Refused with `StackBadRequestError` on a
   * stack with no relay, which has no cursor it could have minted.
   * See docs/spec/events.md § Subscribing.
   */
  since?: string;
  /**
   * Where a throwing handler's error goes, and on a relaying stack a
   * connection the relay could not restore. Without one a handler error is
   * rethrown asynchronously; it never reaches the mutation's caller.
   */
  onError?: (err: unknown) => void;
  /**
   * A gap opened that resumption could not close: reconcile by query.
   * Never fires on a local stack. Can fire on the first connection when
   * the far end will not honor `since`.
   */
  onReset?: () => void;
};

/**
 * The record-storage half of an adapter: structured data, queries,
 * associations, versioning, type definitions, and stack identity.
 */
export interface StackRecordAdapter {
  readonly capabilities: StackCapabilities;

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
  createRecord(record: StackRecord, opts?: JournalOptions): Promise<StackRecord>;
  getRecord(id: RecordId): Promise<StackRecord | null>;
  /**
   * Apply a change set in one write — the only multi-aspect atomic write a
   * record has, so a publish cannot half-land. Never touches `typeId`; see
   * commitMigration(). `Stack` validates it and computes `bumpsVersion`,
   * and never hands an adapter a change set that changes nothing.
   * See docs/spec/data-model.md § Mutations.
   */
  mutateRecord(
    id: RecordId,
    changes: RecordChangeSet,
    opts?: MutateOptions & BumpVersionOptions,
  ): Promise<StackRecord>;
  /**
   * Returns the record this call acted on: as it now stands after a soft
   * delete, and as it stood immediately before destruction after a
   * purge — captured inside the same write, so nothing can observe or alter
   * it in between. Null when there was no record to delete, which is the
   * only case that mutates nothing.
   */
  deleteRecord(
    id: RecordId,
    opts?: { purge?: boolean } & MutateOptions,
  ): Promise<StackRecord | null>;
  /** Reverse a soft delete. Returns the record as it now stands. */
  undeleteRecord(id: RecordId, opts?: MutateOptions): Promise<StackRecord>;
  /**
   * `query.sort`, when present, always carries a `direction`: `Stack`
   * resolves the defaults before any adapter sees the query.
   */
  queryRecords(query: StackQuery): Promise<QueryResult>;

  // Associations
  /**
   * Apply a list of adds and removes as one write, all or none, removes
   * before adds. Never bumps `version`/`updatedAt` and never snapshots — a
   * set-add composes regardless of write order. A list mixing authority
   * and data elements is refused.
   * See docs/spec/adapters.md § Amending associations.
   */
  amendAssociations(
    id: RecordId,
    changes: AssociationEdit[],
    opts?: JournalOptions,
  ): Promise<StackRecord>;

  // Versions
  /**
   * Snapshots newest first; omitting `query` reads every version.
   * See docs/spec/versioning.md § Version history.
   */
  getVersions(id: RecordId, query?: VersionsQuery): Promise<RecordVersion[]>;
  getVersion(id: RecordId, version: number): Promise<RecordVersion | null>;
  /**
   * Standalone snapshot write, outside of a mutation's own atomic path.
   * Mutating methods above take a `snapshot` option instead, so the
   * snapshot and the mutation land in one write — see SnapshotOptions.
   */
  saveVersion(id: RecordId, version: RecordVersion): Promise<void>;

  /**
   * Read a record's change journal, oldest first — required, on the same
   * footing as getVersions(). A recovery mechanism an app cannot rely on is
   * most of the way to no mechanism at all, so an adapter with no journal
   * refuses the call rather than declining to have the method.
   * See docs/spec/journal.md § Reading it.
   */
  getJournal(id: RecordId, query?: JournalQuery): Promise<RecordJournalEntry[]>;
  /**
   * Restore a record to a previous version's `content` and `typeId` —
   * everything a snapshot carries. Containment, listing and associations
   * are left where they stand, there being nothing to restore them *from*.
   * Bumps version internally; throws StackNotFoundError if the version
   * doesn't exist.
   */
  restoreVersion(id: RecordId, version: number, opts?: MutateOptions): Promise<StackRecord>;

  /**
   * Commit a migration: write new content under a new typeId in one step.
   * This is the only way a record's typeId changes after creation — used by
   * Stack.commitMigration() and Stack.migrateAll(); Stack.mutate() never
   * changes typeId as a side effect. Bumps version internally.
   */
  commitMigration(
    id: RecordId,
    toTypeId: TypeId,
    content: Record<string, unknown>,
    opts?: MutateOptions,
  ): Promise<StackRecord>;

  // Types
  saveType(type: StackType): Promise<void>;
  getType(id: TypeId): Promise<StackType | null>;
  listTypes(): Promise<StackType[]>;

  /**
   * Atomically verify fileId is unreferenced and purge its metadata
   * records, returning them; StackConflictError if still referenced.
   * Optional — Stack.deleteAttachment() has a non-atomic fallback.
   * `metadataTypeIds` is the resolved `_attachment` family, so an adapter
   * needs no baseId concept. See docs/spec/attachments.md § Deleting attachments.
   */
  deleteUnreferencedAttachmentRecords?(
    fileId: FileId,
    metadataTypeIds: TypeId[],
  ): Promise<StackRecord[]>;

  /**
   * Relay changes that originated elsewhere — the inverse direction from
   * `Stack`, which emits every change made through it. Optional, and
   * absent on every local adapter: exactly one process owns a stack's
   * storage, so locally there is no third party whose writes could have
   * been missed. See docs/spec/events.md § Where events come from.
   */
  subscribeChanges?(
    opts: SubscribeOptions,
    handler: (change: RecordChange) => void,
  ): Promise<Unsubscribe>;

  // Lifecycle
  flush?(): Promise<void>;
  close?(): Promise<void>;
}

/** One stored blob, as reported by StackBlobAdapter.listBlobs(). */
export type BlobInfo = {
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
  // Bytes only — "attachment" is the record-backed concept at the Stack layer
  putBlob(data: Uint8Array): Promise<FileId>;
  /**
   * Returns a plain `Uint8Array` (never a subclass such as `Buffer`) that the
   * caller owns: changing it never changes the stored bytes.
   */
  getBlob(fileId: FileId): Promise<Uint8Array>;
  deleteBlob(fileId: FileId): Promise<void>;

  /**
   * Enumerate every blob currently in storage. Optional — without it,
   * garbage collection can't find bare-bytes orphans (bytes with no
   * metadata record at all). See docs/spec/attachments.md § Garbage
   * collection.
   */
  listBlobs?(): Promise<BlobInfo[]>;

  // Lifecycle
  flush?(): Promise<void>;
  close?(): Promise<void>;
}

/**
 * A complete adapter: record storage and blob storage combined.
 * Pass this to Stack.open(). Build one with combineAdapters() when you
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
    putAttachmentWithMetadata?(data: Uint8Array, opts: PutAttachmentOptions): Promise<StackRecord>;
  };

/**
 * The two identities a token establishes — an Actor whose `principalId` is
 * always populated, equal to `subjectId` on an undelegated token, so a
 * server reading one never has to default it. Passes to `Stack.asActor()`
 * as is. See docs/spec/access-control.md § Delegation: principal and subject.
 */
export type TokenSession = Actor & {
  principalId: EntityId;
};

export type TokenInfo = TokenSession & {
  id: string;
  label?: string;
  createdAt: Date;
  expiresAt?: Date;
};

/**
 * Bearer-token issuance and lookup for servers — standalone, not a slot on
 * StackAdapter. createToken() trusts its caller: the handshake verifies the
 * principal's DID first, and a differing `subjectId` is asserted by the
 * owner out of band. Store tokens outside the portable stack file.
 * See docs/spec/wire-format.md § Authentication.
 */
export interface StackTokenStore {
  createToken(
    actor: Actor,
    opts?: { label?: string; expiresAt?: Date },
  ): Promise<{
    id: string;
    token: string;
  }>;
  lookupToken(token: string): Promise<TokenSession | null>;
  listTokens(): Promise<TokenInfo[]>;
  revokeToken(id: string): Promise<void>;
}
