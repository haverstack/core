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
 * Content keys that name JavaScript's object machinery rather than a
 * field. Undeclared content fields are allowed by design, so without this
 * they reach `merged[key] = value` in applyMergePatch — where `__proto__`
 * invokes the prototype setter instead of setting a field.
 *
 * That is not a prototype-pollution gadget today: JSON.stringify writes
 * only own-enumerable properties, so a reassigned prototype never reaches
 * storage, and JSON.parse recreates `__proto__` as an own property rather
 * than invoking the setter, so a stored one round-trips inertly. The
 * defect is that the two write paths disagree — a merge patch to
 * `__proto__` silently vanishes, while the same key through create()
 * stores as an ordinary field — and that a future refactor deepening the
 * shallow merge would turn a quiet inconsistency into a real one.
 *
 * Rejecting is more honest than skipping: a caller who sends one of these
 * finds out, rather than watching a write appear to succeed and do
 * nothing. See docs/spec/data-model.md § Reserved content keys.
 */
export const RESERVED_CONTENT_KEYS: readonly string[] = ['__proto__', 'constructor', 'prototype'];

/**
 * Top-level only: a nested occurrence round-trips inertly as an own data
 * property, so it reaches none of the machinery above.
 */
export const validateReservedKeys = (content: Record<string, unknown>): ValidationError[] =>
  RESERVED_CONTENT_KEYS.filter((key) => Object.hasOwn(content, key)).map((key) => ({
    path: key,
    message: `"${key}" is a reserved content key and cannot be used as a field name`,
  }));

/**
 * Characters a content field name may not contain, because a content
 * filter key is a dot-separated path: `{ content: { 'emails.value': x } }`
 * addresses `value` inside `emails`. A field literally named `emails.value`
 * would make that filter mean two things at once, so the ambiguity is
 * removed from the write side — where it is a validation error a caller
 * can act on — rather than from the query side, where it would need an
 * escape convention that silently misreads when a caller forgets it.
 *
 * Wider than what SQLite's JSON path grammar treats as syntax today (`.`,
 * `[`, `]`, `$`, `"`): `*` and `#` are reserved against a path grammar
 * that grows a wildcard or a last-element form. Narrowing a legal charset
 * is a one-way door, so the cost of reserving a character now is nothing
 * and the cost of reserving it later is every stored record.
 *
 * See docs/spec/data-model.md § Content field names.
 */
export const CONTENT_KEY_PATH_METACHARACTERS = ['.', '[', ']', '$', '"', '*', '#'] as const;

const PATH_METACHARACTER_RE = /[.[\]$"*#]/;

/**
 * Unlike the reserved keys above, this holds at every depth: a filter path
 * of `a.b.c` is as ambiguous against a nested field named `b.c` as against
 * a top-level one named `a.b`. Undeclared subtrees are walked too, since
 * they are exactly the fields no schema promised anything about.
 */
const collectKeyErrors = (
  value: unknown,
  prefix: string,
  errors: ValidationError[],
  depth: number,
): void => {
  // The walk stops one level deeper than the longest filter path can
  // reach, so a name this never inspects is a name no filter can address.
  // Array nesting spends a level here and a segment there alike.
  if (depth > MAX_VALIDATION_DEPTH) return;
  if (Array.isArray(value)) {
    value.forEach((item, i) => collectKeyErrors(item, `${prefix}[${i}]`, errors, depth + 1));
    return;
  }
  if (value === null || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (PATH_METACHARACTER_RE.test(key)) {
      errors.push({
        path,
        message:
          `Field name "${key}" contains a reserved character ` +
          `(${CONTENT_KEY_PATH_METACHARACTERS.join(' ')}) and cannot be used as a field name`,
      });
    }
    collectKeyErrors(child, path, errors, depth + 1);
  }
};

/** Recursive — see collectKeyErrors. */
export const validateContentKeys = (content: Record<string, unknown>): ValidationError[] => {
  const errors: ValidationError[] = [];
  collectKeyErrors(content, '', errors, 0);
  return errors;
};

/**
 * A schema may not declare a field a content filter could never name.
 * Recurses into `object` properties; `array` items carry no field names of
 * their own beyond the object properties nested under them.
 */
export const validateSchemaFieldNames = (
  schema: TypeSchema,
  prefix = '',
  errors: ValidationError[] = [],
  depth = 0,
): ValidationError[] => {
  if (depth > MAX_VALIDATION_DEPTH) return errors;
  for (const [key, def] of Object.entries(schema)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (PATH_METACHARACTER_RE.test(key)) {
      errors.push({
        path,
        message:
          `Field name "${key}" contains a reserved character ` +
          `(${CONTENT_KEY_PATH_METACHARACTERS.join(' ')}) and cannot be declared in a schema`,
      });
    }
    let inner: FieldDef = def;
    while (inner.kind === 'array') inner = inner.items;
    if (inner.kind === 'object')
      validateSchemaFieldNames(inner.properties, path, errors, depth + 1);
  }
  return errors;
};

/**
 * Returns true if the content is valid against the schema.
 * Use validateContent() directly to get error details.
 */
export const isValid = (content: Record<string, unknown>, schema: TypeSchema): boolean =>
  validateContent(content, schema).length === 0;
