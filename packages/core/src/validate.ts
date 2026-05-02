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
): void => {
  if (def.kind === 'array') {
    if (!Array.isArray(value)) {
      errors.push({ path, message: `Expected array, got ${typeof value}` });
      return;
    }
    value.forEach((item, i) => validateField(item, def.items, `${path}[${i}]`, errors));
    return;
  }

  if (def.kind === 'object') {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      errors.push({ path, message: `Expected object, got ${typeof value}` });
      return;
    }
    validateContent(value as Record<string, unknown>, def.properties, path, errors);
    return;
  }

  // Scalar validation
  if (def.kind === 'date') {
    if (typeof value !== 'string' || isNaN(Date.parse(value as string))) {
      errors.push({
        path,
        message: `Expected ISO 8601 date string, got ${typeof value}`,
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
): ValidationError[] => {
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

    validateField(value, def, path, errors);
  }

  return errors;
};

/**
 * Returns true if the content is valid against the schema.
 * Use validateContent() directly to get error details.
 */
export const isValid = (content: Record<string, unknown>, schema: TypeSchema): boolean =>
  validateContent(content, schema).length === 0;
