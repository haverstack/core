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
  content: Record<string, unknown>;
  updatedAt: Date;
  entityId?: RecordId; // Who made this change
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
  | 'record-ref'; // Reference to another record by ID

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
export type GrantAction = 'create' | 'update-own' | 'update-any' | 'delete-own' | 'delete-any';

/** Content for _grant records */
export type GrantContent = {
  /** Which record type the grant applies to. */
  typeId: TypeId;
  /** Which actions are permitted. */
  actions: GrantAction[];
};

/** Reserved system type IDs */
export const SYSTEM_TYPES = {
  ENTITY: '_entity',
  APP: '_app',
  GROUP: '_group',
  /** Creation-permission grants. See GrantContent. */
  GRANT: '_grant',
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
// Attachment metadata
// -------------------------------------------------------

export type AttachmentMeta = {
  mimeType: string;
  size: number; // bytes
  createdAt: Date;
  filename?: string; // original filename if provided at upload time
};

// -------------------------------------------------------
// Adapter interface
// -------------------------------------------------------

/**
 * Every storage backend implements this interface.
 * The Stack class is a thin orchestration layer on top.
 */
export interface StackAdapter {
  readonly capabilities: AdapterCapabilities;

  // Config
  getConfig(key: string): Promise<string | null>;
  setConfig(key: string, value: string): Promise<void>;

  // Records
  createRecord(record: StackRecord): Promise<StackRecord>;
  getRecord(id: RecordId): Promise<StackRecord | null>;
  updateRecord(id: RecordId, changes: Partial<StackRecord>): Promise<StackRecord>;
  deleteRecord(id: RecordId, opts?: { hard?: boolean }): Promise<void>;
  queryRecords(query: StackQuery): Promise<QueryResult>;

  // Associations
  associate(id: RecordId, association: Association): Promise<void>;
  dissociate(id: RecordId, association: Association): Promise<void>;

  // Versions
  getVersions(id: RecordId): Promise<RecordVersion[]>;
  getVersion(id: RecordId, version: number): Promise<RecordVersion | null>;
  saveVersion(id: RecordId, version: RecordVersion): Promise<void>;

  // Types
  saveType(type: StackType): Promise<void>;
  getType(id: TypeId): Promise<StackType | null>;
  listTypes(): Promise<StackType[]>;

  // Attachments
  putAttachment(data: Uint8Array, mimeType: string, filename?: string): Promise<FileId>;
  getAttachment(fileId: FileId): Promise<Uint8Array>;
  deleteAttachment(fileId: FileId): Promise<void>;
  getAttachmentMeta(fileId: FileId): Promise<AttachmentMeta | null>;

  // Lifecycle
  flush?(): Promise<void>;
  close?(): Promise<void>;
}
