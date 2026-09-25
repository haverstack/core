/**
 * @haverstack/core
 * -------------------------------------------------------
 * Core library for Haverstack — portable personal data stack.
 *
 * Exports the Stack class, the app/plugin-facing data types, and the
 * general-purpose utilities every caller needs. Audience-specific surfaces
 * live behind their own subpaths, which this root does not re-export:
 *   ./did      — key generation, custody and signing (did:key)
 *   ./wire     — the auth handshake and attachment-download policy shared
 *                by both sides of a client/server connection
 *   ./adapter  — the interfaces a storage adapter implements
 *   ./testing  — the in-memory MemoryAdapter for tests
 * Storage adapters are published as separate packages:
 *   @haverstack/adapter-sqlite
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
  IfVersionOptions,
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
  StackClosedError,
  StackMisconfigurationError,
  StackRelayScopeError,
} from './errors.js';
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
  RelationshipTargetPattern,
  QuerySort,
  NativeSortField,
  QueryResult,
  DateRange,
  Migration,
  MigrationFn,
  StackAdapter,
  StackFeatures,
  TokenSession,
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
