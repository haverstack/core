/**
 * Type schemas: field definitions and the registered StackType.
 */

import type { TypeId, BaseId } from './ids.js';

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
