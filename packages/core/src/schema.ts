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
 * `text` share an identical value set (the distinction is presentation/
 * indexing intent, not data shape), so they're mutually acceptable for
 * reading. Everything else requires an exact kind match — notably `date`
 * is NOT compatible with `string`: it carries a parse/validity guarantee
 * a plain string doesn't.
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
 * Check whether a candidate schema is read-compatible with a required schema:
 * whether records of the candidate Type carry every field an app needs to
 * *read*, at a kind the app can safely consume. This licenses consuming
 * records, not writing them — a consumer writing through a "compatible" view
 * still has to validate against the candidate's full schema.
 *
 * A candidate is compatible if, for every *required* field in the required
 * schema, the candidate declares that field as required with a read-compatible
 * kind (see READ_COMPATIBLE). Optional fields in the required schema are
 * ignored. Array and object fields recurse into their items/properties, up
 * to MAX_COMPATIBILITY_DEPTH.
 *
 * Apps that need precise type matching should compare typeIds directly.
 * isCompatible() is for duck-typed consumption across types.
 */
export const isCompatible = (candidateSchema: TypeSchema, requiredSchema: TypeSchema): boolean =>
  isCompatibleAtDepth(candidateSchema, requiredSchema, 0);

// -------------------------------------------------------
// Schema evolution legality (drift detection)
// -------------------------------------------------------
//
// Deliberately distinct from isCompatible() above, despite both walking a
// TypeSchema pair recursively:
//
//   - isCompatible()  — read compatibility: may a consumer of this shape
//                        read records of that type? (`text` and `string`
//                        interchange; a candidate may have *extra* required
//                        fields the consumer doesn't ask about.)
//   - diffSchemas()   — evolution legality: may this schema replace that one
//                        in place, under the same typeId? (`text` and
//                        `string` are NOT interchangeable — changing a
//                        field's declared kind is drift regardless of value-
//                        level overlap; nothing about the *other* schema's
//                        extra fields is relevant, every field on both sides
//                        matters.)
//
// Conflating them is the obvious future bug: a read-compatible schema
// (e.g. one that merely has extra optional fields) is not necessarily a
// legal in-place evolution, and vice versa.

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
 * Check whether `candidate` is a legal in-place evolution of `stored` — the
 * same typeId, a new schemaHash. Legal iff every existing field is
 * unchanged (same kind, same required-ness, recursively into object
 * properties and array items) and every field `candidate` adds beyond
 * `stored` is optional. Returns the list of violations; empty means legal.
 *
 * This is the callable-facing sibling of isCompatible() but answers a
 * different question — see the note above. Removing a field, changing a
 * field's kind, or flipping required either direction (optional→required or
 * required→optional) is drift: a version bump communicates that a consumer
 * pinned to the old shape needs to notice, in a way an in-place change
 * cannot.
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
