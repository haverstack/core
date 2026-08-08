/**
 * Stack — Content Validation
 * -------------------------------------------------------
 * Validates a Record's content object against a TypeSchema.
 * Returns a list of validation errors — empty means valid.
 *
 * Validates recursively for array and object field kinds.
 * Coercion is never performed — types must match exactly.
 */

import type { TypeSchema, FieldDef, ScalarFieldKind } from './types.js';

const MAX_VALIDATION_DEPTH = 32;

/** fileId format: SHA-256 hex, lowercase — matches blob-adapter-disk's assertFileId(). */
const FILE_ID_RE = /^[0-9a-f]{64}$/;

/**
 * ISO 8601 date or date-time shape. The regex pins the shape (bare
 * `Date.parse` accepts engine-dependent non-ISO formats); `Date.parse`
 * still runs afterward as a calendar sanity check. See
 * docs/spec/data-model.md § Types.
 */
const ISO_8601_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?)?$/;

// -------------------------------------------------------
// Validation errors
// -------------------------------------------------------

export type ValidationError = {
  path: string; // Dot-separated field path, e.g. "address.city" or "phones[0]"
  message: string;
};

// -------------------------------------------------------
// Internal helpers
// -------------------------------------------------------

const jsTypeForScalar = (kind: ScalarFieldKind): string => {
  switch (kind) {
    case 'string':
    case 'text':
    case 'record-ref':
    case 'file-ref':
      return 'string';
    case 'number':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'date':
      return 'string'; // Dates are transmitted as ISO 8601 strings
  }
};

const validateField = (
  value: unknown,
  def: FieldDef,
  path: string,
  errors: ValidationError[],
  depth = 0,
): void => {
  if (depth > MAX_VALIDATION_DEPTH) {
    errors.push({
      path,
      message: `Schema nesting exceeds maximum depth of ${MAX_VALIDATION_DEPTH}`,
    });
    return;
  }

  if (def.kind === 'array') {
    if (!Array.isArray(value)) {
      errors.push({ path, message: `Expected array, got ${typeof value}` });
      return;
    }
    value.forEach((item, i) => validateField(item, def.items, `${path}[${i}]`, errors, depth + 1));
    return;
  }

  if (def.kind === 'object') {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      errors.push({ path, message: `Expected object, got ${typeof value}` });
      return;
    }
    validateContent(value as Record<string, unknown>, def.properties, path, errors, depth + 1);
    return;
  }

  // Scalar validation
  if (def.kind === 'date') {
    if (
      typeof value !== 'string' ||
      !ISO_8601_RE.test(value) ||
      isNaN(Date.parse(value as string))
    ) {
      errors.push({
        path,
        message: `Expected ISO 8601 date string, got ${typeof value}`,
      });
    }
    return;
  }

  if (def.kind === 'file-ref') {
    if (typeof value !== 'string' || !FILE_ID_RE.test(value)) {
      errors.push({
        path,
        message: 'Expected a 64-character lowercase hex fileId (SHA-256)',
      });
    }
    return;
  }

  const expected = jsTypeForScalar(def.kind);
  if (typeof value !== expected) {
    errors.push({
      path,
      message: `Expected ${expected}, got ${typeof value}`,
    });
  }
};

// -------------------------------------------------------
// Public API
// -------------------------------------------------------

/**
 * Validate content against a schema, collecting all errors.
 * @param content  - The record's content object
 * @param schema   - The TypeSchema to validate against
 * @param prefix   - Internal: dot path prefix for nested validation
 * @param errors   - Internal: error accumulator for recursive calls
 */
export const validateContent = (
  content: Record<string, unknown>,
  schema: TypeSchema,
  prefix = '',
  errors: ValidationError[] = [],
  depth = 0,
): ValidationError[] => {
  if (depth > MAX_VALIDATION_DEPTH) {
    errors.push({
      path: prefix || '(root)',
      message: `Schema nesting exceeds maximum depth of ${MAX_VALIDATION_DEPTH}`,
    });
    return errors;
  }

  // Check all schema fields
  for (const [key, def] of Object.entries(schema)) {
    const path = prefix ? `${prefix}.${key}` : key;
    const value = content[key];

    if (value === undefined || value === null) {
      if (def.required) {
        errors.push({ path, message: 'Required field is missing' });
      }
      continue;
    }

    validateField(value, def, path, errors, depth);
  }

  return errors;
};

/**
 * Returns true if the content is valid against the schema.
 * Use validateContent() directly to get error details.
 */
export const isValid = (content: Record<string, unknown>, schema: TypeSchema): boolean =>
  validateContent(content, schema).length === 0;
