/**
 * Stack — Schema Utilities
 * -------------------------------------------------------
 * Schema hashing and type compatibility checks.
 *
 * Hashing produces a stable SHA-256 fingerprint of a TypeSchema
 * by canonicalizing it first (alphabetical keys, minified JSON).
 * This is used for drift detection — not type identity, which is
 * the namespaced ID controlled by the app author.
 */

import type { TypeSchema, FieldDef, ScalarFieldKind } from './types.js';

// -------------------------------------------------------
// Canonical schema serialization
// -------------------------------------------------------

/**
 * Recursively sort all object keys alphabetically so that two schemas
 * with the same fields in different orders produce the same hash.
 */
const canonicalizeFieldDef = (def: FieldDef): unknown => {
  if (def.kind === 'array') {
    return {
      items: canonicalizeFieldDef(def.items),
      kind: def.kind,
      ...(def.required !== undefined && { required: def.required }),
    };
  }

  if (def.kind === 'object') {
    return {
      kind: def.kind,
      properties: canonicalizeSchema(def.properties),
      ...(def.required !== undefined && { required: def.required }),
    };
  }

  // Scalar
  return {
    kind: def.kind,
    ...(def.required !== undefined && { required: def.required }),
  };
};

const canonicalizeSchema = (schema: TypeSchema): unknown => {
  return Object.fromEntries(
    Object.keys(schema)
      .sort()
      .map((key) => [key, canonicalizeFieldDef(schema[key])]),
  );
};

// -------------------------------------------------------
// Hashing
// -------------------------------------------------------

/**
 * Compute a stable SHA-256 hash of a TypeSchema.
 * Used for drift detection — if two records share a typeId but their
 * schemas hash differently, the schema was mutated without a version bump.
 */
export const hashSchema = async (schema: TypeSchema): Promise<string> => {
  const canonical = JSON.stringify(canonicalizeSchema(schema));
  const buffer = new TextEncoder().encode(canonical);
  const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
};

// -------------------------------------------------------
// Type compatibility
// -------------------------------------------------------

/**
 * Kinds acceptable in a candidate field, per required kind. `string` and
 * `text` are mutually acceptable for reading; everything else requires an
 * exact match. See docs/spec/data-model.md § Type compatibility.
 */
const READ_COMPATIBLE: Record<ScalarFieldKind, ScalarFieldKind[]> = {
  string: ['string', 'text'],
  text: ['text', 'string'],
  number: ['number'],
  boolean: ['boolean'],
  date: ['date'],
  'record-ref': ['record-ref'],
  'file-ref': ['file-ref'],
};

// Candidate schemas can come from another app's Type definition (the
// untrusted side of duck-typed consumption), so recursion into array
// items / object properties is depth-bounded — matches MAX_VALIDATION_DEPTH
// in validate.ts. Past the limit we can't verify compatibility, so we
// fail closed (treat as incompatible) rather than risk a stack overflow.
const MAX_COMPATIBILITY_DEPTH = 32;

/**
 * Check whether a candidate field satisfies a required field, recursing
 * into array items and object properties.
 */
const isFieldCompatible = (candidate: FieldDef, required: FieldDef, depth: number): boolean => {
  if (depth > MAX_COMPATIBILITY_DEPTH) return false;
  if (required.kind === 'array') {
    return (
      candidate.kind === 'array' && isFieldCompatible(candidate.items, required.items, depth + 1)
    );
  }
  if (required.kind === 'object') {
    return (
      candidate.kind === 'object' &&
      isCompatibleAtDepth(candidate.properties, required.properties, depth + 1)
    );
  }
  if (candidate.kind === 'array' || candidate.kind === 'object') return false;
  return READ_COMPATIBLE[required.kind].includes(candidate.kind);
};

const isCompatibleAtDepth = (
  candidateSchema: TypeSchema,
  requiredSchema: TypeSchema,
  depth: number,
): boolean => {
  if (depth > MAX_COMPATIBILITY_DEPTH) return false;
  return Object.entries(requiredSchema).every(([key, def]) => {
    if (!def.required) return true;
    const field = candidateSchema[key];
    return field !== undefined && field.required === true && isFieldCompatible(field, def, depth);
  });
};

/**
 * Check whether a candidate schema is read-compatible with a required
 * schema — licensing duck-typed *consumption* of records, not writing
 * them. Every required field must be declared required at a
 * read-compatible kind; array/object fields recurse. See
 * docs/spec/data-model.md § Type compatibility.
 */
export const isCompatible = (candidateSchema: TypeSchema, requiredSchema: TypeSchema): boolean =>
  isCompatibleAtDepth(candidateSchema, requiredSchema, 0);

// -------------------------------------------------------
// Schema evolution legality (drift detection)
// -------------------------------------------------------
//
// Deliberately distinct from isCompatible() above: read compatibility and
// evolution legality are different relations that disagree on text/string.
// See docs/spec/data-model.md § Type compatibility.

export type SchemaDriftViolation = {
  /** Field path where the drift was detected, e.g. "title" or "author.name". Empty string means array-item context. */
  path: string;
  message: string;
};

// Same rationale and bound as MAX_COMPATIBILITY_DEPTH: a pathological or
// circular schema shouldn't be walked forever. Past the limit we can't
// verify the change is additive, so we fail closed — report it as drift
// rather than silently accept.
const MAX_DIFF_DEPTH = 32;

const diffField = (
  path: string,
  stored: FieldDef,
  candidate: FieldDef,
  depth: number,
  violations: SchemaDriftViolation[],
): void => {
  if (depth > MAX_DIFF_DEPTH) {
    violations.push({ path, message: 'exceeds max nesting depth; cannot verify additive change' });
    return;
  }
  if (stored.kind !== candidate.kind) {
    violations.push({
      path,
      message: `kind changed from "${stored.kind}" to "${candidate.kind}"`,
    });
    return; // kinds differ — nested comparison (properties/items) is meaningless
  }
  if (!!stored.required !== !!candidate.required) {
    violations.push({
      path,
      message: `required changed from ${!!stored.required} to ${!!candidate.required}`,
    });
  }
  if (stored.kind === 'array' && candidate.kind === 'array') {
    diffField(`${path}[]`, stored.items, candidate.items, depth + 1, violations);
  }
  if (stored.kind === 'object' && candidate.kind === 'object') {
    diffFields(path, stored.properties, candidate.properties, depth + 1, violations);
  }
};

const diffFields = (
  prefix: string,
  stored: TypeSchema,
  candidate: TypeSchema,
  depth: number,
  violations: SchemaDriftViolation[],
): void => {
  if (depth > MAX_DIFF_DEPTH) {
    violations.push({
      path: prefix,
      message: 'exceeds max nesting depth; cannot verify additive change',
    });
    return;
  }
  for (const [key, storedDef] of Object.entries(stored)) {
    const path = prefix ? `${prefix}.${key}` : key;
    const candidateDef = candidate[key];
    if (!candidateDef) {
      violations.push({ path, message: 'field removed' });
      continue;
    }
    diffField(path, storedDef, candidateDef, depth, violations);
  }
  for (const [key, candidateDef] of Object.entries(candidate)) {
    if (key in stored) continue; // already compared above
    if (candidateDef.required) {
      const path = prefix ? `${prefix}.${key}` : key;
      violations.push({ path, message: 'new field is required; new fields must be optional' });
    }
    // A new optional field is exactly what additive evolution allows — no violation.
  }
};

/**
 * Check whether `candidate` is a legal in-place evolution of `stored`:
 * every existing field unchanged (recursively) and every added field
 * optional. Returns the list of violations; empty means legal. See
 * docs/spec/data-model.md § Schema drift detection.
 */
export const diffSchemas = (stored: TypeSchema, candidate: TypeSchema): SchemaDriftViolation[] => {
  const violations: SchemaDriftViolation[] = [];
  diffFields('', stored, candidate, 0, violations);
  return violations;
};

// -------------------------------------------------------
// Type ID parsing
// -------------------------------------------------------

/**
 * Parse a versioned TypeId into its base and version components.
 * e.g. "com.example.myapp/note@2" → { baseId: "com.example.myapp/note", version: 2 }
 * Returns null if the ID is not versioned (e.g. system types at definition time).
 */
export const parseTypeId = (typeId: string): { baseId: string; version: number } | null => {
  const match = typeId.match(/^(.+)@(\d+)$/);
  if (!match) return null;
  return { baseId: match[1], version: parseInt(match[2], 10) };
};

/**
 * Build a versioned TypeId from a base ID and version number.
 * e.g. ("com.example.myapp/note", 2) → "com.example.myapp/note@2"
 */
export const buildTypeId = (baseId: string, version: number): string => `${baseId}@${version}`;

/**
 * Extract the base (family) ID from a TypeId, tolerating an already-bare
 * baseId (no "@n" suffix) as a no-op. Used to compare across versions —
 * e.g. a grant on "comment@1" and a record at "comment@2" share a baseId.
 */
export const baseIdOf = (typeId: string): string => parseTypeId(typeId)?.baseId ?? typeId;

/**
 * True if typeId is well-formed as either a bare baseId (no version
 * suffix) or a versioned TypeId ("baseId@version") — the shape
 * GrantContent.typeId accepts, the same tolerance baseIdOf() applies.
 * Not used by defineType(), which requires a version and needs the parsed
 * {baseId, version} itself — it calls parseTypeId() directly instead.
 */
export const isWellFormedTypeId = (typeId: string): boolean => {
  if (typeof typeId !== 'string' || typeId.trim().length === 0) return false;
  return !typeId.includes('@') || parseTypeId(typeId) !== null;
};
