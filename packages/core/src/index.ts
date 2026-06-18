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
} from './stack.js';
export type {
  StackClient,
  CreateRecordOptions,
  GetRecordOptions,
  DeleteRecordOptions,
} from './stack.js';

// Permissions
export { checkAccess } from './access.js';
export type { AccessMode, RecordResolver } from './access.js';

// Types
export type {
  RecordId,
  TypeId,
  FileId,
  AttachmentMeta,
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
  StackAdapter,
  EntityContent,
  AppContent,
  GroupContent,
  GrantAction,
  GrantContent,
} from './types.js';

export { SYSTEM_TYPES } from './types.js';

// Utilities
export { generateId, crockford32Encode, crockford32Decode } from './id.js';
export { hashSchema, isCompatible, parseTypeId, buildTypeId } from './schema.js';
export { validateContent, isValid } from './validate.js';
export type { ValidationError } from './validate.js';
