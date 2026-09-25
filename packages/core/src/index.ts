/**
 * @haverstack/core
 * -------------------------------------------------------
 * Core library for Haverstack — portable personal data stack.
 *
 * Exports the Stack class, the app/plugin-facing data types, and the
 * general-purpose utilities every caller needs. Audience-specific surfaces
 * live behind their own subpaths, and every export has exactly one home —
 * nothing here is repeated in a subpath, or the reverse:
 *   ./did      — key generation, custody and signing (did:key)
 *   ./wire     — the request encoding, auth handshake, token store and
 *                attachment-download policy shared by both sides of a
 *                client/server connection
 *   ./adapter  — the interfaces a storage adapter implements
 *   ./testing  — the in-memory MemoryAdapter for tests
 * Storage adapters are published as separate packages — adapter-local,
 * adapter-api, record-adapter-sqlite, record-adapter-do-sqlite,
 * blob-adapter-disk and blob-adapter-s3, all under @haverstack/.
 */

// Core class and client interface
export { Stack } from './stack.js';
export { ScopedStack } from './scoped-stack.js';
export type {
  StackClient,
  CreateRecordOptions,
  BackdatableCreateRecordOptions,
  StackOptions,
  DefineTypeOptions,
  GetRecordOptions,
  DeleteRecordOptions,
  DeleteResult,
  DeleteAndReturnResult,
  CollectAttachmentGarbageOptions,
  CollectAttachmentGarbageResult,
} from './stack.js';

// The error taxonomy
export {
  StackError,
  StackValidationError,
  StackMigrationError,
  StackPermissionError,
  StackNotFoundError,
  StackConflictError,
  StackVersionConflictError,
  StackBadRequestError,
  StackSchemaDriftError,
  StackPayloadTooLargeError,
  StackTimeoutError,
} from './errors.js';
// Local errors outside the taxonomy — no wire representation, and no
// `Stack` prefix. See docs/spec/wire-format.md § The taxonomy root.
export { UseAfterCloseError, InvalidAdapterError, RelayScopeError } from './errors.js';
export type { StackErrorCode } from './errors.js';

// Types
export type {
  RecordId,
  TypeId,
  BaseId,
  FileId,
  EntityId,
  AppId,
  AttachmentContent,
  StackRecord,
  RecordChangeSet,
  RecordVersion,
  RecordJournalEntry,
  JournalQuery,
  Actor,
  ActorOptions,
  ChangeKind,
  ChangeOp,
  ChangeActor,
  RecordChange,
  ChangeFilter,
  SubscribeOptions,
  Unsubscribe,
  StackType,
  TypeSchema,
  FieldDef,
  ScalarFieldDef,
  ArrayFieldDef,
  ObjectFieldDef,
  ScalarFieldKind,
  Association,
  TagAssociation,
  AttachmentAssociation,
  RelationshipAssociation,
  PermissionAssociation,
  Grantee,
  GroupRole,
  AnyoneAssociation,
  AuthorityAssociation,
  DataAssociation,
  AssociationChange,
  RelationshipTarget,
  RecordTarget,
  EntityTarget,
  ExternalTarget,
  StackQuery,
  RecordFilter,
  RelatedToFilter,
  AttachmentFilter,
  RelationshipTargetPattern,
  QuerySort,
  NativeSortField,
  QueryResult,
  DateRange,
  Migration,
  MigrationFn,
  StackCapabilities,
  ContentFilterReach,
  MissingCapability,
  IfVersionOptions,
  EntityContent,
  AppContent,
  GroupContent,
  GrantAction,
  GrantContent,
  GrantGrantee,
  TypeGrant,
  PutAttachmentOptions,
  ConfigContent,
} from './types.js';

export type { GrantQuery } from './grants.js';

export { SYSTEM_TYPES, NATIVE_SORT_FIELDS } from './types.js';

// Utilities

// No in-repo caller: client-minted IDs are the default per spec, and an app
// needing the ID before the write round-trips has to mint one itself.
export { generateId } from './id.js';
export { hashSchema, isCompatible } from './schema.js';
export type { SchemaDriftViolation } from './schema.js';
export type { ValidationError } from './validate.js';
export { applyMergePatch } from './merge.js';
