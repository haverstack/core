/**
 * @haverstack/core
 * -------------------------------------------------------
 * Core library for Haverstack — portable personal data stack.
 *
 * Exports the Stack class, all types, and utility functions.
 * Storage adapters are published as separate packages:
 *   @haverstack/adapter-sqlite
 */

// Core class and client interface
export {
  Stack,
  ScopedStack,
  StackValidationError,
  StackMigrationError,
  StackPermissionError,
  StackNotFoundError,
  StackConflictError,
  StackQueryError,
} from './stack.js';
export type {
  StackClient,
  CreateRecordOptions,
  StackOptions,
  GetRecordOptions,
  DeleteRecordOptions,
  CollectAttachmentGarbageOptions,
  CollectAttachmentGarbageResult,
} from './stack.js';

// Permissions
export { checkAccess } from './access.js';
export type { AccessMode, RecordResolver } from './access.js';

// Types
export type {
  RecordId,
  TypeId,
  FileId,
  AttachmentContent,
  StackRecord,
  RecordVersion,
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
  Permission,
  StackQuery,
  RecordFilter,
  QuerySort,
  QueryResult,
  DateRange,
  Migration,
  MigrationFn,
  AdapterCapabilities,
  StackFeatures,
  StackRecordAdapter,
  StackBlobAdapter,
  BlobFileInfo,
  StackAdapter,
  StackTokenStore,
  TokenInfo,
  EntityContent,
  AppContent,
  GroupContent,
  GrantAction,
  GrantContent,
  ConfigContent,
} from './types.js';

export { SYSTEM_TYPES } from './types.js';

// Adapter composition
export { combineAdapters } from './combine.js';

// Utilities
export {
  generateId,
  crockford32Encode,
  crockford32Decode,
  isValidIdFormat,
  idTimestamp,
} from './id.js';
export { hashSchema, isCompatible, parseTypeId, buildTypeId, baseIdOf } from './schema.js';
export { validateContent, isValid } from './validate.js';
export type { ValidationError } from './validate.js';
export { applyMergePatch } from './merge.js';
export {
  isSafeAttachmentContentType,
  inferContentTypeFromFilename,
  resolveAttachmentDownloadContentType,
  FORCED_CONTENT_TYPE,
  NOSNIFF_HEADER_NAME,
  NOSNIFF_HEADER_VALUE,
} from './attachment-download.js';
export type { AttachmentDownloadContentType } from './attachment-download.js';
