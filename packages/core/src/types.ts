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
  mimeType: string;
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
  | { access: 'entity'; entityId: RecordId; read: boolean; write: boolean }
  | { access: 'group'; groupId: RecordId; read: boolean; write: boolean };

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
  entityId?: RecordId; // Author entity, if different from stack owner
  appId?: RecordId; // App that created this record
  deletedAt?: Date; // Present if soft-deleted
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
  entityId?: RecordId; // Who made this change
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

/** Content for _entity records */
export type EntityContent = {
  /** Display name — human-friendly, not necessarily unique. May contain spaces and punctuation. e.g. "Jane Smith" */
  name: string;
  /** Short unique identifier within a namespace — URL-safe, no spaces. e.g. "janesmith". Like a username. Optional for private entities. */
  handle?: string;
};

/** Content for _app records */
export type AppContent = {
  /** Display name of the app e.g. "My Notes App" */
  name: string;
  /**
   * Semver string e.g. "1.0.0". The app's unique machine-readable identity
   * is already captured by the _app record's appId (e.g. "com.example.myapp"),
   * so no handle is needed here.
   */
  version?: string;
};

/** Content for _group records */
export type GroupContent = {
  /** Display name — human-friendly, not necessarily unique. May contain spaces and punctuation. e.g. "Jane's Book Club" */
  name: string;
  /** Short unique identifier — URL-safe, no spaces. e.g. "janes-book-club". Useful for groups other people need to reference. Optional for private groups. */
  handle?: string;
  /** If present, this group owns a shared collaborative stack at this URL. Absent = permission-only group. */
  stackUrl?: string;
};

/** Actions that can be granted via a _grant record. */
export type GrantAction =
  | 'create'
  | 'read-own'
  | 'read-any'
  | 'update-own'
  | 'update-any'
  | 'delete-own'
  | 'delete-any';

/** Content for _grant records */
export type GrantContent = {
  /** Which record type the grant applies to. */
  typeId: TypeId;
  /** Which actions are permitted. */
  actions: GrantAction[];
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
  /** Entity ID of the stack owner. */
  entityId: string;
  /** IANA timezone string e.g. "America/New_York". */
  timezone: string;
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
  appId?: RecordId | RecordId[];
  entityId?: RecordId | RecordId[];
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
  contentFieldQuery: boolean;
  sortableFields: Array<QuerySort['field']>;
};

/** What a Stack can do, as seen by app and plugin code. */
export type StackFeatures = AdapterCapabilities;

// -------------------------------------------------------
// Adapter interfaces
// -------------------------------------------------------

/**
 * The record-storage half of an adapter. Handles structured data, queries,
 * associations, versioning, type definitions, and stack identity.
 */
/**
 * Opt-in optimistic-concurrency precondition, accepted by every mutation
 * that bumps a record's version. When set, the mutation only applies if
 * the record's current version equals `expectedVersion`; otherwise the
 * adapter throws StackVersionConflictError without applying any part of
 * the mutation. The check happens atomically inside the adapter's write
 * (e.g. `UPDATE ... WHERE id = ? AND version = ?`, checking the affected
 * row count) — never as a read-then-write, which would just move the race
 * down a layer. Omit to keep today's last-writer-wins behavior.
 */
export type ExpectedVersionOptions = {
  expectedVersion?: number;
};

export interface StackRecordAdapter {
  readonly capabilities: AdapterCapabilities;

  /** Entity ID of the stack owner. Set during adapter initialization. */
  readonly ownerEntityId: string;
  /** IANA timezone string for this stack e.g. "America/New_York". */
  readonly timezone: string;

  // Records
  createRecord(record: StackRecord): Promise<StackRecord>;
  getRecord(id: RecordId): Promise<StackRecord | null>;
  /**
   * Apply a content-only RFC 7396 merge patch. `null` removes a field;
   * other values replace it; omitted fields are retained. Bumps `version`
   * and `updatedAt` as part of the same write. Does not touch `typeId` —
   * a patch that also commits a pending migration goes through
   * commitMigration() instead, since a content-only patch has no way to
   * carry a type change.
   */
  patchContent(
    id: RecordId,
    patch: Record<string, unknown | null>,
    opts?: ExpectedVersionOptions,
  ): Promise<StackRecord>;
  deleteRecord(id: RecordId, opts?: { hard?: boolean } & ExpectedVersionOptions): Promise<void>;
  /** Reverse a soft delete. Returns the record as it now stands. */
  undeleteRecord(id: RecordId, opts?: ExpectedVersionOptions): Promise<StackRecord>;
  queryRecords(query: StackQuery): Promise<QueryResult>;

  // Associations
  associate(id: RecordId, association: Association, opts?: ExpectedVersionOptions): Promise<void>;
  dissociate(id: RecordId, association: Association, opts?: ExpectedVersionOptions): Promise<void>;

  /** Replace all permissions on a record. Bumps version internally. */
  setPermissions(
    id: RecordId,
    permissions: Permission[],
    opts?: ExpectedVersionOptions,
  ): Promise<void>;

  // Versions
  getVersions(id: RecordId): Promise<RecordVersion[]>;
  getVersion(id: RecordId, version: number): Promise<RecordVersion | null>;
  saveVersion(id: RecordId, version: RecordVersion): Promise<void>;
  /**
   * Restore a record to a previous version's content (and associations,
   * when the snapshot has them). Never restores permissions. Bumps version
   * internally. Throws StackNotFoundError if the version doesn't exist.
   */
  restoreVersion(
    id: RecordId,
    version: number,
    opts?: ExpectedVersionOptions,
  ): Promise<StackRecord>;

  /**
   * Commit a migration: write new content under a new typeId in one step.
   * This is the only way a record's typeId changes after creation — used
   * exclusively by Stack.migrateAll(); Stack.update() never changes typeId
   * as a side effect. Bumps version internally.
   */
  commitMigration(
    id: RecordId,
    toTypeId: TypeId,
    content: Record<string, unknown>,
  ): Promise<StackRecord>;

  // Types
  saveType(type: StackType): Promise<void>;
  getType(id: TypeId): Promise<StackType | null>;
  listTypes(): Promise<StackType[]>;

  /**
   * Atomically verify fileId is unreferenced by any record's attachment
   * association, then hard-delete every record of `metadataTypeId` whose
   * content.fileId matches it — all within a single adapter call, so
   * nothing can add a new reference between the check and the delete.
   * Returns the ids of the deleted metadata records (empty if none exist,
   * e.g. bare bytes left by an interrupted upload). Throws
   * StackConflictError if fileId is still referenced.
   *
   * Optional: Stack.deleteAttachment() falls back to a non-atomic
   * check-then-act sequence for adapters that don't implement this.
   */
  deleteUnreferencedAttachmentRecords?(fileId: FileId, metadataTypeId: TypeId): Promise<RecordId[]>;

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
   * Enumerate every blob currently in storage. Optional — capability-flagged,
   * like StackRecordAdapter.deleteUnreferencedAttachmentRecords(). Without it,
   * Stack.collectAttachmentGarbage() can still collect files that have
   * _attachment@1 metadata but no live/soft-deleted referencing record; it
   * just can't find bare-bytes orphans (bytes with zero metadata records at
   * all, left by a putAttachment() that stored bytes but crashed before
   * creating the metadata record) — enumerating the store directly is the
   * only way to find those.
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
export type StackAdapter = StackRecordAdapter & StackBlobAdapter;

export type TokenInfo = {
  id: string;
  entityId: string;
  label?: string;
  createdAt: Date;
  expiresAt?: Date;
};

/**
 * Bearer-token issuance and lookup for server implementations. Neither
 * `Stack` nor `StackClient` touches this — it's server-side tooling, not
 * part of the record/blob adapter contract, so it's a standalone
 * interface rather than a slot on `StackAdapter`. Server implementations
 * accept storage and tokens as separate parts (`{ adapter, tokens }`)
 * rather than sniffing an adapter for token methods.
 *
 * Token storage is deliberately decoupled from record storage: the
 * portable stack file is "your data, take it with you," and auth
 * material shouldn't travel with it (an export/backup shouldn't also
 * hand over — or resurrect — bearer tokens). Implementations SHOULD
 * default to storing tokens outside the stack's own file, treating
 * in-file storage as an explicit opt-in at most.
 */
export interface StackTokenStore {
  createToken(
    entityId: string,
    opts?: { label?: string; expiresAt?: Date },
  ): Promise<{
    id: string;
    token: string;
  }>;
  lookupToken(token: string): Promise<{ entityId: string } | null>;
  listTokens(): Promise<TokenInfo[]>;
  revokeToken(id: string): Promise<void>;
}
