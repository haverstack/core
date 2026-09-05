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
export {
  Stack,
  ScopedStack,
  StackError,
  StackValidationError,
  StackMigrationError,
  StackPermissionError,
  StackNotFoundError,
  StackConflictError,
  StackVersionConflictError,
  StackQueryError,
  StackSchemaDriftError,
  StackPayloadTooLargeError,
  StackTimeoutError,
  StackClosedError,
  StackRelayScopeError,
} from './stack.js';
export type {
  StackErrorCode,
  StackClient,
  CreateRecordOptions,
  BackdatableCreateRecordOptions,
  StackOptions,
  GetRecordOptions,
  DeleteRecordOptions,
  IfVersionOptions,
  CollectAttachmentGarbageOptions,
  CollectAttachmentGarbageResult,
} from './stack.js';

// Types
export type {
  RecordId,
  TypeId,
  FileId,
  EntityId,
  AttachmentContent,
  StackRecord,
  RecordVersion,
  ActorOptions,
  ChangeKind,
  ChangeOp,
  ChangeActor,
  RecordChange,
  ChangeFilter,
  SubscribeOptions,
  Unsubscribe,
  ExpectedVersionOptions,
  SnapshotOptions,
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
  RelationshipTarget,
  RecordTarget,
  EntityTarget,
  ExternalTarget,
  Permission,
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
  ConfigContent,
} from './types.js';

export { SYSTEM_TYPES } from './types.js';

// Utilities

// No in-repo caller: client-minted IDs are the default per spec, and an app
// needing the ID before the write round-trips has to mint one itself.
export { generateId } from './id.js';
export { hashSchema, isCompatible } from './schema.js';
export type { SchemaDriftViolation } from './schema.js';
export type { ValidationError } from './validate.js';
export { applyMergePatch } from './merge.js';
