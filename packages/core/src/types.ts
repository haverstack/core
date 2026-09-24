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

/**
 * `attachmentRecordId` names the `_attachment` record whose upload
 * established this reference — annotation, not identity, since `fileId`
 * alone is what GC, the `attachmentFileId` filter and file access ask
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
  grantee: PermissionGrantee;
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

/** Who a permission reaches — the shared arms, and nothing wider. */
export type PermissionGrantee = Grantee;

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
 * One association a write moved, and what it moved from. Every inverse is
 * local to one element — there is no join back to a sibling list, so there
 * is no join key to get wrong. `previous` is carried in full, annotation
 * included, which is what makes both a `repoint` and a `remove` undoable.
 * See docs/spec/journal.md § The entry.
 */
export type AssociationChange =
  | { op: 'add'; association: Association }
  | { op: 'repoint'; association: Association; previous: Association }
  | { op: 'remove'; previous: Association };

/**
 * The aspects of an existing record one mutate() call may move, in any
 * combination. Every key replaces the aspect it names except
 * `contentPatch`, which merges at the top level — omitted keeps, `null`
 * removes. Keys are read for presence, so `unlisted: false` and
 * `parentId: null` are changes; an omitted key is untouched.
 *
 * `associations` replaces the whole set. associate()/dissociate() amend it
 * instead, which is the spelling that survives two writers touching one
 * record, so they stay their own verbs rather than folding in here.
 * See docs/spec/data-model.md § Mutations.
 */
export type RecordChanges = {
  contentPatch?: Record<string, unknown | null>;
  parentId?: string | null;
  permissions?: AuthorityAssociation[];
  associations?: DataAssociation[];
  unlisted?: boolean;
};

/** The keys of a change set, for presence checks that must not miss one. */
export const RECORD_CHANGE_KEYS = [
  'contentPatch',
  'parentId',
  'permissions',
  'associations',
  'unlisted',
] as const satisfies readonly (keyof RecordChanges)[];

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
   * docs/spec/unlisted.md.
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
   * The record's author, carried through from `record.entityId` — not the
   * entity that performed the change this version records.
   * See docs/spec/versioning.md § Version history.
   */
  entityId?: EntityId;
  /** Who performed the mutation that produced this version. */
  updatedBy?: EntityId;
  /** The principal behind that mutation, when it isn't `updatedBy`. */
  updatedVia?: EntityId;
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

/**
 * Who a Grant reaches, spelled affirmatively. Each tier names itself, so
 * no dropped field turns one into another: a `_grant` Record that lost its
 * grantee names nobody rather than everybody.
 *
 * `{ kind: 'authenticated' }` reaches any authenticated entity — narrower
 * than a Record permission's `{ kind: 'anyone' }`, which reaches anonymous
 * requesters too. The two tiers deliberately share no word.
 *
 * `role` is required on the group arm — `member` is the wider set, `admin`
 * the narrower, matching the roster labels where admin implies member (see
 * docs/spec/identity.md § Group). A group grantee never satisfies the
 * principal half of a delegated request.
 * See docs/spec/access-control.md § Type-level grants.
 */
export type GrantGrantee = Grantee | { kind: 'authenticated' };

/** Content for _grant records */
export type GrantContent = {
  /** Which record type the grant applies to. */
  typeId: TypeId;
  /** Which actions are permitted. */
  actions: GrantAction[];
  /** Who the grant reaches. Required — see GrantGrantee. */
  grantee: GrantGrantee;
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
 * line with `tags` and `hasAttachment`, which likewise have no match-any
 * form. See docs/spec/data-model.md § Filter.
 */
export type RelatedToFilter =
  | { label: string; target?: RelationshipTargetPattern }
  | { label?: string; target: RelationshipTargetPattern };

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
  /**
   * Records carrying a matching relationship association. Either half may
   * be given alone and each is a pattern: a bare `label` matches every
   * target under it, and an `external` target with no `id` matches the
   * whole namespace. An absent `stackUrl` on a `record` target matches
   * only local targets. See docs/spec/data-model.md § Filter.
   */
  relatedTo?: RelatedToFilter;
  attachmentFileId?: FileId; // Records that reference this attachment file ID

  /**
   * Exact match on content fields, keyed by a dot-separated path
   * (`'emails.value'`). An array anywhere along the path is matched
   * element-wise, so the motivating question — which contact holds this
   * email address — is one filter. A multi-segment key needs the
   * `filter.content: 'path'` capability. POST /query only.
   * See docs/spec/data-model.md § Filter.
   */
  content?: Record<string, unknown>;

  /**
   * Paths that must hold a value: the question `content` cannot ask,
   * since a filter value matches what is there rather than whether
   * anything is. Element-wise like `content`, so a path holds a value
   * when at least one non-null value is reachable at it. Needs the
   * filter.contentPresent capability. POST /query only.
   * See docs/spec/data-model.md § Filter.
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
 * array is the source of truth — NativeSortField is derived from it so the
 * runtime checks that narrow a wire value or a cursor to this set (see
 * parseQuery(), normalizeCapabilities(), and the SQLite adapters' cursor
 * decoding) can't drift from the type.
 */
export const NATIVE_SORT_FIELDS = ['createdAt', 'updatedAt', 'version'] as const;

export type NativeSortField = (typeof NATIVE_SORT_FIELDS)[number];

/**
 * Order by a native column or by a top-level content field — two members
 * rather than one widened `field`, because a content field named
 * `version` would otherwise be indistinguishable from the native column.
 * A `'content.'` prefix can't carry the distinction either: `.` is the
 * path separator `parseContentFilterKey()` splits on.
 * See docs/spec/data-model.md § Sorting by a content field.
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
   * Records are returned exactly as stored by default ("stored"). Pass
   * "latest" to apply the registered migration chain in memory before
   * returning — never written back. Throws StackMigrationError if any
   * matched record has no registered path to the latest version.
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

/**
 * How far into `content` a filter key may reach. The rungs nest —
 * `'path'` is `'field'` plus traversal — so they are one ordered value
 * rather than a pair of booleans that can spell a state no adapter can be
 * in. A value a client does not recognize reads as `'none'`: refusing a
 * query is recoverable, answering it with an unfiltered superset presented
 * as a filtered result is not.
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
 * What an adapter honors, grouped by the query surface each entry gates:
 * every flag under `filter`/`sort` is named for the query key it answers
 * for, so the capability a query needs is derivable from the query rather
 * than memorized. `limits` sits apart because a byte ceiling is not a
 * feature to gate on but a number to pre-check against.
 * See docs/spec/adapters.md § Adapter capabilities.
 */
export type AdapterCapabilities = {
  filter: {
    /**
     * Required `'path'` for local/in-process adapters; a wire adapter may
     * report a shallower rung, driven by the server's discovery response.
     * Stack.query() throws StackQueryError rather than silently widening.
     */
    content: ContentFilterReach;
    /**
     * Whether `filter.contentPresent` is honored. Beside the reach ladder
     * rather than a rung on it: a server promising to match a content
     * value has not thereby promised to answer whether one is there at
     * all, and reading it as such hands a client the unfiltered superset
     * that ignoring the filter produces. Meaningful only where `content`
     * is not `'none'` — presence travels in the `POST /records/query`
     * body, which a server reaching no content does not expose.
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
     * in `fields`: content fields are app-defined and unbounded, and an
     * adapter that indexes content for sorting indexes every top-level
     * scalar, so there is nothing per-field left to declare. Independent
     * of `filter.content` — a server may order by a content field without
     * offering to filter on one, and filtering is a scan where ordering
     * wants an index.
     */
    contentField: boolean;
  };
  /**
   * Ceilings a client can check before spending a request, never a
   * substitute for the server's own limit, which stays authoritative.
   * `null` means this client cannot pre-check, not that nothing is
   * enforced. Local adapters declare `null` for both: nothing at the
   * storage layer imposes a ceiling, and a caller with in-process access
   * to the database can spend its own memory however it likes.
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

/** What a Stack can do, as seen by app and plugin code. */
export type StackFeatures = AdapterCapabilities;

/**
 * A capability a query can be refused for, as its path into
 * AdapterCapabilities — the same name the spec and a discovery response
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
 * Whether a mutateRecord() call advances `version`/`updatedAt` at all.
 * `Stack` computes this from which aspects a change set actually moves — a
 * change set touching only `associations`, `parentId` and/or `unlisted`
 * doesn't bump, the same rule StackRecordAdapter.associate()/dissociate()
 * follow unconditionally. Absent means `true`; every other mutating method
 * bumps every time, so only mutateRecord() takes this. See
 * docs/spec/versioning.md § Version history.
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
  updatedBy?: EntityId;
  updatedVia?: EntityId;
};

/**
 * The part of a change that the record cannot report once the write has
 * landed: which aspects moved, who moved them, and what an association
 * mutation added, removed or overwrote. Everything else a journal entry
 * carries — `seq`, `at`, `version`, `typeId`, `parentId` — the adapter
 * stamps from the row it just wrote, so the two can never drift.
 *
 * That split is the whole argument for the tier: content's prior state is
 * recoverable from a snapshot, and nothing else's is recoverable from
 * anything but this. See docs/spec/journal.md.
 */
export type JournalEntryInput = {
  ops: ChangeOp[];
  kind: ChangeKind;
  actor?: ChangeActor;
  /** The container a move took the record out of, `null` for the root. */
  previousParentId?: RecordId | null;
  /**
   * What an association mutation moved, one tagged edit per association.
   * The journal's own shape, not the feed's two flat lists: a log whose
   * whole argument is prior state carries `previous` beside the thing that
   * displaced it, rather than leaving a consumer to re-derive which entry
   * of one list overwrote which entry of another. See
   * docs/spec/journal.md § The entry.
   */
  associations?: AssociationChange[];
};

/**
 * One durable entry in a record's change journal.
 *
 * Envelope-level by design — `content` lives on a RecordVersion, and
 * duplicating it here would make the journal the larger of the two stores
 * for no recovery anyone asked for.
 * See docs/spec/journal.md § Ordering for why `seq` is the only ordering.
 */
export type RecordJournalEntry = JournalEntryInput & {
  seq: number;
  /** When the entry was appended — not the record's `updatedAt`, which an association change leaves alone. */
  at: Date;
  /**
   * The version this change produced; unchanged from before on
   * associate/dissociate, reparent, unlist and list.
   */
  version: number;
  typeId: TypeId;
  /** Where the record sat after the change, absent for the root. */
  parentId?: RecordId;
};

/**
 * Accepted by every mutating StackRecordAdapter method, and by
 * associate()/dissociate(), which take no other options. The adapter
 * appends the entry inside the SAME write as the mutation, so a crash
 * between the two cannot leave a change unjournaled.
 *
 * Unlike SnapshotOptions there is no collision to heal: `seq` is
 * allocated by the adapter inside that write rather than computed by
 * `Stack` from a value it read earlier.
 */
export type JournalOptions = {
  journal?: JournalEntryInput;
};

/** Window into a record's journal. Omitting both reads the whole log, oldest first. */
export type JournalQuery = {
  /** Entries after this seq, exclusive. */
  sinceSeq?: number;
  limit?: number;
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
 * reshare from an edit. `associate`, `dissociate`, `reparent`, `unlist`
 * and `list` carry the record's version/updatedAt exactly as they stood
 * before the call; every other entry bumps. See docs/spec/versioning.md
 * § Version history.
 */
export type ChangeOp =
  | 'create'
  | 'patch'
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
  /**
   * Every aspect this version moved, derived by diffing the record against
   * its prior state rather than read off the request — a change set that
   * names an aspect without moving it is not reported as moving it. Never
   * empty; multi-entry only for a mutate() change set, since every other op
   * names a whole-record transition and is emitted alone.
   * See docs/spec/events.md § The event shape.
   */
  ops: ChangeOp[];
  recordId: RecordId;
  /** As stored at the moment of the change. */
  typeId: TypeId;
  /**
   * The version this change produced; on `purged`, the version destroyed.
   * Unchanged from the record's prior version on `associate`/`dissociate`,
   * which don't bump.
   */
  version: number;
  /**
   * As persisted by this change; on `purged`, when the delete ran.
   * Unchanged from the record's prior `updatedAt` on `associate`/
   * `dissociate`, which don't touch it.
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
  associationsAdded?: Association[];
  /**
   * Associations no longer present, identity only — kind and label, plus
   * `fileId` for an attachment — present whenever `ops` includes
   * `dissociate`. An attachment's `attachmentRecordId` is never repeated
   * here, the same way a `purged` frame never carries what it destroyed.
   */
  associationsRemoved?: Association[];
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
   * docs/spec/unlisted.md.
   */
  includeUnlisted?: boolean;
  /**
   * Resume from this cursor rather than the present — the last `seq` that
   * was present on a delivered `RecordChange`. A relaying stack delivers
   * its own local writes through the same handler and those carry none, so
   * a consumer that stores every change's `seq` unconditionally erases its
   * own cursor on its next write.
   *
   * Forwarded to the adapter as `SubscribeChangesOptions.since`, so it
   * only means something where a relay exists: a stack with none has no
   * third-party writes to have missed, and therefore no cursor it could
   * ever have minted. Passing `since` there throws `StackQueryError`
   * rather than silently starting from the present, which would let the
   * caller believe it resumed when it did not. A cursor outside the
   * framable charset is refused the same way, so a malformed one reports
   * identically whatever adapter is underneath. See
   * docs/spec/events.md § Subscribing.
   */
  since?: string;
  /**
   * Where a throwing handler's error goes. Without one the error is
   * rethrown asynchronously rather than swallowed; either way it never
   * reaches the caller of the mutation that produced the event.
   */
  onError?: (err: unknown) => void;
  /**
   * A gap opened that resumption could not close: reconcile by query.
   * Never fires on a local stack, which has no gap to open. Can fire on
   * the very first connection when `since` names a cursor the far end
   * will not honor — that is a gap too, and the one an app most needs to
   * hear about.
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
  createRecord(record: StackRecord, opts?: JournalOptions): Promise<StackRecord>;
  getRecord(id: RecordId): Promise<StackRecord | null>;
  /**
   * Apply a change set — any combination of content patch, `parentId`,
   * `permissions`, `associations` and `unlisted` — in one write. It is the
   * only multi-aspect atomic write a record has: a publish is one act, so
   * separate per-aspect methods would leave it able to half-land.
   *
   * The content patch merges at the top level only — each key it names is
   * replaced whole. Never touches `typeId`; a type change goes through
   * commitMigration() instead. `associations` replaces the stored set,
   * where associate()/dissociate() amend it.
   *
   * `opts.bumpsVersion` says whether this call advances `version`/
   * `updatedAt` and stores the snapshot — `false` for a change set that
   * touches only association sets, `permissions` among them, matching
   * associate()/dissociate() below, which never bump. `Stack` computes it; an adapter never has to infer it
   * from the change set's own keys.
   *
   * `Stack` owns everything above storage: validation, the acyclicity
   * walk, the per-key gates, and deciding there is anything to write at
   * all — an adapter is never handed a change set that changes nothing.
   * See docs/spec/data-model.md § Mutations and docs/spec/versioning.md
   * § Version history.
   */
  mutateRecord(
    id: RecordId,
    changes: RecordChanges,
    opts?: ExpectedVersionOptions &
      SnapshotOptions &
      BumpVersionOptions &
      ActorOptions &
      JournalOptions,
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
    opts?: { hard?: boolean } & ExpectedVersionOptions &
      SnapshotOptions &
      ActorOptions &
      JournalOptions,
  ): Promise<StackRecord | null>;
  /** Reverse a soft delete. Returns the record as it now stands. */
  undeleteRecord(
    id: RecordId,
    opts?: ExpectedVersionOptions & SnapshotOptions & ActorOptions & JournalOptions,
  ): Promise<StackRecord>;
  queryRecords(query: StackQuery): Promise<QueryResult>;

  // Associations
  /**
   * Add an association. Never bumps `version`/`updatedAt` and never
   * snapshots — a set-add composes regardless of write order.
   * See docs/spec/versioning.md § Version history.
   */
  associate(id: RecordId, association: Association, opts?: JournalOptions): Promise<StackRecord>;
  /** Remove an association. Never bumps `version`/`updatedAt` — see associate(). */
  dissociate(id: RecordId, association: Association, opts?: JournalOptions): Promise<StackRecord>;

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
  restoreVersion(
    id: RecordId,
    version: number,
    opts?: ExpectedVersionOptions & SnapshotOptions & ActorOptions & JournalOptions,
  ): Promise<StackRecord>;

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
    opts?: ExpectedVersionOptions & SnapshotOptions & ActorOptions & JournalOptions,
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
   *
   * `metadataTypeIds` is the resolved `_attachment` family, passed as
   * concrete typeIds so an adapter never needs a baseId concept of its
   * own — the same split Stack.query() makes for `filter.baseId`.
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
