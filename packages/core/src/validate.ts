/**
 * Stack — Content and Schema Validation
 * -------------------------------------------------------
 * Validates a Record's content object against a TypeSchema, and a
 * TypeSchema itself before it is defined — including the field-name rules
 * both share, so no stored name is one a content filter cannot address.
 * Every check returns a list of validation errors — empty means valid.
 *
 * Validates recursively for array and object field kinds.
 * Coercion is never performed — types must match exactly.
 */

import type { TypeSchema, FieldDef, ScalarFieldKind } from './types/index.js';

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

/** Shared by the 422 for a value outside the list and the 409 for removed values. */
export const formatEnumValues = (values: readonly string[]): string =>
  values.map((v) => JSON.stringify(v)).join(', ');

const jsTypeForScalar = (kind: ScalarFieldKind): string => {
  switch (kind) {
    case 'string':
    case 'text':
    case 'record-ref':
    case 'file-ref':
    case 'enum':
      return 'string';
    case 'number':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'date':
      return 'string'; // Dates are transmitted as ISO 8601 strings
  }
};

const typeName = (value: unknown): string => (value instanceof Date ? 'a Date' : typeof value);

const isPlainJsonObject = (value: object): boolean => {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

/**
 * Content is plain JSON at every depth, including inside `open` containers,
 * so adapters that store the value as given and adapters that serialize it
 * read back the same thing. Nesting is held to the cap declared fields
 * already meet, so an open value cannot buy an unbounded walk.
 * See docs/spec/data-model.md § Types.
 */
const validateJsonValue = (
  value: unknown,
  path: string,
  errors: ValidationError[],
  depth: number,
  ancestors: object[] = [],
): void => {
  if (depth > MAX_VALIDATION_DEPTH) {
    errors.push({
      path,
      message: `Content nesting exceeds maximum depth of ${MAX_VALIDATION_DEPTH}`,
    });
    return;
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      errors.push({ path, message: `Expected a finite number, got ${value}` });
    }
    return;
  }
  const isArray = Array.isArray(value);
  if (typeof value !== 'object' || (!isArray && !isPlainJsonObject(value))) {
    errors.push({ path, message: `Expected a JSON value, got ${typeName(value)}` });
    return;
  }
  if (ancestors.includes(value)) {
    errors.push({ path, message: 'Expected a JSON value, got a circular reference' });
    return;
  }
  const next = [...ancestors, value];
  if (isArray) {
    value.forEach((item, i) => validateJsonValue(item, `${path}[${i}]`, errors, depth + 1, next));
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    validateJsonValue(child, `${path}.${key}`, errors, depth + 1, next);
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
      errors.push({ path, message: `Expected array, got ${typeName(value)}` });
      return;
    }
    // An open array is the list-shaped counterpart of an open object: the
    // schema places a list here and says nothing about what it holds.
    if (def.open) {
      validateJsonValue(value, path, errors, depth);
      return;
    }
    const items = def.items;
    value.forEach((item, i) => validateField(item, items, `${path}[${i}]`, errors, depth + 1));
    return;
  }

  if (def.kind === 'object') {
    if (
      typeof value !== 'object' ||
      value === null ||
      Array.isArray(value) ||
      !isPlainJsonObject(value)
    ) {
      errors.push({ path, message: `Expected object, got ${typeName(value)}` });
      return;
    }
    // An open object says "an object lives here" and nothing about its
    // interior, so there is no set of declared keys to hold it to.
    if (def.open) {
      validateJsonValue(value, path, errors, depth);
      return;
    }
    validateContent(value as Record<string, unknown>, def.properties, path, errors, depth + 1);
    return;
  }

  if (def.kind === 'date') {
    if (value instanceof Date) {
      errors.push({
        path,
        message:
          'Expected an ISO 8601 date string, got a Date. Pass date.toISOString() for a moment in time, or a "YYYY-MM-DD" string for a calendar day.',
      });
      return;
    }
    if (
      typeof value !== 'string' ||
      !ISO_8601_RE.test(value) ||
      isNaN(Date.parse(value as string))
    ) {
      errors.push({
        path,
        message: `Expected ISO 8601 date string, got ${typeName(value)}`,
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
      message: `Expected ${expected}, got ${typeName(value)}`,
    });
  } else if (typeof value === 'number' && !Number.isFinite(value)) {
    errors.push({ path, message: `Expected a finite number, got ${value}` });
  } else if (def.kind === 'enum' && !def.values.includes(value as string)) {
    errors.push({
      path,
      message: `Expected one of ${formatEnumValues(def.values)}, got ${JSON.stringify(value)}`,
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

  // An undeclared field is refused rather than stored: a key outside the
  // schema is a typo, a stale writer or not content at all, and storing it
  // makes each look like a write that worked. An `open` object field holds
  // what a schema cannot describe.
  // See docs/spec/data-model.md § Undeclared content fields.
  for (const key of Object.keys(content)) {
    if (Object.hasOwn(schema, key)) continue;
    errors.push({
      path: prefix ? `${prefix}.${key}` : key,
      message: `"${key}" is not declared by this type`,
    });
  }

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
 * Copy of `content` with every `null`/`undefined` field removed, recursing
 * into declared nested objects (including those inside declared arrays)
 * but not into `open` ones, whose interior is opaque to core.
 * See docs/spec/data-model.md § Absent content fields.
 */
export const dropAbsentFields = (
  content: Record<string, unknown>,
  schema: TypeSchema,
): Record<string, unknown> => dropAbsentObject(content, schema, 0);

// fromEntries, not `out[key] = …`: assignment to `__proto__` would invoke
// the setter and swallow a key validateReservedKeys must still see.
const dropAbsentObject = (
  content: Record<string, unknown>,
  schema: TypeSchema,
  depth: number,
): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(content)
      .filter(([, value]) => value !== undefined && value !== null)
      .map(([key, value]) => {
        const def = Object.hasOwn(schema, key) ? schema[key] : undefined;
        return [key, def ? dropAbsentValue(value, def, depth) : value];
      }),
  );

const dropAbsentValue = (value: unknown, def: FieldDef, depth: number): unknown => {
  // Past the limit validation reports the nesting error; stop recursing.
  if (depth > MAX_VALIDATION_DEPTH) return value;
  if (def.kind === 'object' && !def.open && isPlainObject(value)) {
    return dropAbsentObject(value, def.properties, depth + 1);
  }
  if (def.kind === 'array' && !def.open && Array.isArray(value)) {
    return value.map((item) => dropAbsentValue(item, def.items, depth + 1));
  }
  return value;
};

/**
 * Content keys naming JavaScript's object machinery rather than a field.
 * A write path that sets a key by assignment and one that defines it
 * disagree about `__proto__`, so all three are refused at the write rather
 * than skipped, and the caller finds out.
 * See docs/spec/data-model.md § Reserved content keys.
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
 * Every scalar kind, as a total Record so adding one to ScalarFieldKind
 * fails to compile until it is listed here.
 */
const SCALAR_KINDS: Record<ScalarFieldKind, true> = {
  string: true,
  number: true,
  boolean: true,
  date: true,
  text: true,
  'record-ref': true,
  'file-ref': true,
  enum: true,
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const validateEnumValuesShape = (list: unknown, path: string, errors: ValidationError[]): void => {
  if (!Array.isArray(list) || list.length === 0) {
    errors.push({ path, message: 'An enum must declare "values", a non-empty array of strings' });
    return;
  }
  const seen = new Set<string>();
  for (const entry of list) {
    if (typeof entry !== 'string') {
      errors.push({ path, message: `"values" entries must be strings, got ${typeName(entry)}` });
    } else if (seen.has(entry)) {
      errors.push({ path, message: `"values" lists ${JSON.stringify(entry)} more than once` });
    }
    seen.add(entry as string);
  }
};

const validateFieldDefShape = (
  def: unknown,
  path: string,
  errors: ValidationError[],
  depth: number,
): void => {
  if (!isPlainObject(def)) {
    errors.push({ path, message: `A field definition must be an object, got ${typeof def}` });
    return;
  }

  if (def.required !== undefined && typeof def.required !== 'boolean') {
    errors.push({ path, message: '"required" must be a boolean' });
  }
  if (def.open !== undefined && typeof def.open !== 'boolean') {
    errors.push({ path, message: '"open" must be a boolean' });
  }
  const isOpen = def.open === true;

  if (typeof def.kind !== 'string') {
    errors.push({ path, message: 'A field definition must name a "kind"' });
    return;
  }

  const knownKind =
    def.kind === 'array' || def.kind === 'object' || Object.hasOwn(SCALAR_KINDS, def.kind);
  if (def.values !== undefined && knownKind && def.kind !== 'enum') {
    errors.push({ path, message: `"values" is only allowed on an enum field, not "${def.kind}"` });
  }
  // Unknown keys are otherwise ignored, but `enum` names a kind: as a key it
  // would read as a constraint that nothing enforces.
  if (def.enum !== undefined) {
    errors.push({ path, message: '"enum" is a field kind, not a field key' });
  }

  if (def.kind === 'array') {
    if (isOpen) {
      if (def.items !== undefined) {
        errors.push({ path, message: 'An open array cannot also declare "items"' });
      }
      return;
    }
    if (def.items === undefined) {
      errors.push({
        path,
        message: 'An array must declare "items", or "open": true to leave its elements unvalidated',
      });
      return;
    }
    validateFieldDefShape(def.items, `${path}[]`, errors, depth + 1);
    return;
  }

  if (def.kind === 'object') {
    if (isOpen) {
      if (def.properties !== undefined) {
        errors.push({ path, message: 'An open object cannot also declare "properties"' });
      }
      return;
    }
    if (def.properties === undefined) {
      errors.push({
        path,
        message:
          'An object must declare "properties", or "open": true to leave its keys unvalidated',
      });
      return;
    }
    validateSchemaShape(def.properties, path, errors, depth + 1);
    return;
  }

  if (!Object.hasOwn(SCALAR_KINDS, def.kind)) {
    errors.push({
      path,
      message: `"${def.kind}" is not a field kind`,
    });
    return;
  }

  if (def.kind === 'enum') validateEnumValuesShape(def.values, path, errors);
};

/**
 * Check that a schema is a schema before anything reads it as one: off the
 * wire it is JSON TypeScript never saw. A container declaring neither its
 * interior nor `open` would throw out of hashSchema(), and an unknown `kind`
 * would define a field every write fails. See docs/spec/data-model.md § Types.
 */
export const validateSchemaShape = (
  schema: unknown,
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
  if (!isPlainObject(schema)) {
    errors.push({
      path: prefix || '(root)',
      message: `A schema must be an object mapping field names to definitions, got ${typeof schema}`,
    });
    return errors;
  }
  for (const [key, def] of Object.entries(schema)) {
    validateFieldDefShape(def, prefix ? `${prefix}.${key}` : key, errors, depth);
  }
  return errors;
};

/**
 * The same names, refused where a schema declares them, top-level only like
 * the content rule. A declaration cannot license what that rule refuses, so
 * it would define a field no record could hold — and if `required`, a type
 * no record could satisfy. See docs/spec/data-model.md § Reserved content keys.
 */
export const validateSchemaReservedNames = (schema: TypeSchema): ValidationError[] =>
  RESERVED_CONTENT_KEYS.filter((key) => Object.hasOwn(schema, key)).map((key) => ({
    path: key,
    message: `"${key}" is a reserved content key and cannot be declared as a field name`,
  }));

/**
 * `undefined` is not a value a merge patch can carry: `null` deletes, JSON
 * drops the key, and the presence checks read the key as a claim on its
 * field. Top-level only, matching the shallow merge.
 * See docs/spec/data-model.md § Undefined values in a patch.
 */
export const validatePatchValues = (patch: Record<string, unknown>): ValidationError[] =>
  Object.keys(patch)
    .filter((key) => patch[key] === undefined)
    .map((key) => ({
      path: key,
      message: `"${key}" is undefined; omit it to leave the field unchanged, or use null to remove it`,
    }));

/**
 * Characters a field name may not contain, since a content filter key is a
 * dot-separated path: a field named `emails.value` would make one filter
 * mean two things, and the write side is where that is an error a caller
 * can act on. `*` and `#` are reserved ahead of the path grammar, because
 * narrowing a legal charset later costs every stored record. See docs/spec/data-model.md § Content field names.
 */
export const CONTENT_KEY_PATH_METACHARACTERS = ['.', '[', ']', '$', '"', '*', '#'] as const;

/**
 * A filter key is split on `.` before its segments are checked, so a
 * segment is the only place the separator itself cannot appear.
 */
export const CONTENT_SEGMENT_METACHARACTERS = CONTENT_KEY_PATH_METACHARACTERS.filter(
  (char) => char !== '.',
);

/** Derived so the reserved set has one definition, not two that drift. */
const characterClass = (chars: readonly string[]): RegExp =>
  new RegExp(`[${chars.map((char) => char.replace(/[\\\]^-]/g, '\\$&')).join('')}]`);

const PATH_METACHARACTER_RE = characterClass(CONTENT_KEY_PATH_METACHARACTERS);

export const SEGMENT_METACHARACTER_RE = characterClass(CONTENT_SEGMENT_METACHARACTERS);

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
    while (inner.kind === 'array' && !inner.open) inner = inner.items;
    if (inner.kind === 'object' && !inner.open)
      validateSchemaFieldNames(inner.properties, path, errors, depth + 1);
  }
  return errors;
};
