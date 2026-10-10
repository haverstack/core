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
import type { ReadonlyTypeSchema } from './type-handle.js';
import { declaredEnumValues, enumAllows, formatEnumValues } from './validate.js';

// -------------------------------------------------------
// Canonical schema serialization
// -------------------------------------------------------

/**
 * Recursively sort all object keys alphabetically so that two schemas
 * with the same fields in different orders produce the same hash.
 */
const canonicalizeFieldDef = (def: FieldDef): unknown => {
  if (def.kind === 'array') {
    // `open` carries into the hash and `items` drops out of it, for the
    // reason an object's `properties` does below: an open array accepts
    // content a declared one refuses. A closed array omits the flag rather
    // than storing `false`, so declaring it explicitly hashes the same as
    // leaving it off.
    if (def.open) {
      return {
        kind: def.kind,
        open: true,
        ...(def.required !== undefined && { required: def.required }),
      };
    }
    return {
      items: canonicalizeFieldDef(def.items),
      kind: def.kind,
      ...(def.required !== undefined && { required: def.required }),
    };
  }

  if (def.kind === 'object') {
    // An open object and one declaring no properties accept different
    // content, so they must not share a hash.
    if (def.open) {
      return {
        kind: def.kind,
        open: true,
        ...(def.required !== undefined && { required: def.required }),
      };
    }
    return {
      kind: def.kind,
      properties: canonicalizeSchema(def.properties),
      ...(def.required !== undefined && { required: def.required }),
    };
  }

  // Scalar. An enum's `values` are sorted so reordering them is not a change.
  // A malformed stored list is hashed as it is, so it never matches a
  // different malformed one, or a def with no list at all.
  const values = (def as { values?: unknown }).values;
  return {
    kind: def.kind,
    ...(def.required !== undefined && { required: def.required }),
    ...(values !== undefined && { values: Array.isArray(values) ? [...values].sort() : values }),
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
 * `text` are mutually acceptable for reading, and either accepts an enum,
 * whose values are strings; everything else requires an exact match. A
 * required enum takes the subset rule in isFieldCompatible instead. See
 * docs/spec/data-model.md § Type compatibility.
 */
const READ_COMPATIBLE: Record<Exclude<ScalarFieldKind, 'enum'>, ScalarFieldKind[]> = {
  string: ['string', 'text', 'enum'],
  text: ['text', 'string', 'enum'],
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
/** Only a container can be open, so this is false for every scalar. */
const isOpen = (def: FieldDef): boolean =>
  (def.kind === 'array' || def.kind === 'object') && def.open === true;

const MAX_COMPATIBILITY_DEPTH = 32;

/**
 * Check whether a candidate field satisfies a required field, recursing
 * into array items and object properties.
 */
const isFieldCompatible = (candidate: FieldDef, required: FieldDef, depth: number): boolean => {
  if (depth > MAX_COMPATIBILITY_DEPTH) return false;
  if (required.kind === 'array') {
    if (candidate.kind !== 'array') return false;
    // An open requirement asks nothing of the elements, so any array
    // satisfies it; a declared one is unsatisfied by an open candidate,
    // which promises nothing about what it holds.
    if (required.open) return true;
    return !candidate.open && isFieldCompatible(candidate.items, required.items, depth + 1);
  }
  if (required.kind === 'object') {
    if (candidate.kind !== 'object') return false;
    // Same on both sides: an open candidate declares no fields, so it
    // satisfies a required object only where that one asks for none — a bag
    // promises a consumer nothing to read.
    if (required.open) return true;
    return isCompatibleAtDepth(
      candidate.open ? {} : candidate.properties,
      required.properties,
      depth + 1,
    );
  }
  if (candidate.kind === 'array' || candidate.kind === 'object') return false;
  // A consumer expecting an enum can handle only the values it lists. An
  // enum candidate with a missing or empty `values` list promises nothing,
  // so it fails closed.
  if (required.kind === 'enum') {
    if (candidate.kind !== 'enum') return false;
    const values = declaredEnumValues(candidate.values);
    return values.length > 0 && values.every((v) => enumAllows(required.values, v));
  }
  // A required kind outside the union (a foreign or unvalidated schema) can't
  // be checked, so it fails closed too.
  return (READ_COMPATIBLE[required.kind] ?? []).includes(candidate.kind);
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
export const isCompatible = (
  candidateSchema: ReadonlyTypeSchema,
  requiredSchema: ReadonlyTypeSchema,
): boolean => isCompatibleAtDepth(candidateSchema as TypeSchema, requiredSchema as TypeSchema, 0);

// -------------------------------------------------------
// Schema evolution legality (drift detection)
// -------------------------------------------------------
//
// Deliberately distinct from isCompatible() above: read compatibility and
// evolution legality are different relations that disagree on text/string
// and on enum.
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
  // An enum becoming a string accepts strictly more, so it is the one kind
  // change that is additive.
  const widensEnum = stored.kind === 'enum' && candidate.kind === 'string';
  if (stored.kind !== candidate.kind && !widensEnum) {
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
  // Losing a value narrows what an enum accepts; gaining one widens it.
  if (stored.kind === 'enum' && candidate.kind === 'enum') {
    const kept = new Set(declaredEnumValues(candidate.values));
    const removed = declaredEnumValues(stored.values).filter((v) => !kept.has(v));
    if (removed.length > 0) {
      violations.push({ path, message: `enum values removed: ${formatEnumValues(removed)}` });
    }
  }
  // Opening a declared container, or closing an open one, changes which
  // content it accepts in a way no field-by-field diff would show.
  if (isOpen(stored) !== isOpen(candidate)) {
    violations.push({
      path,
      message: isOpen(stored)
        ? `${stored.kind} changed from open to declared`
        : `${stored.kind} changed from declared to open`,
    });
    return;
  }
  if (stored.kind === 'array' && candidate.kind === 'array') {
    if (!stored.open && !candidate.open) {
      diffField(`${path}[]`, stored.items, candidate.items, depth + 1, violations);
    }
  }
  if (stored.kind === 'object' && candidate.kind === 'object') {
    if (!stored.open && !candidate.open) {
      diffFields(path, stored.properties, candidate.properties, depth + 1, violations);
    }
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
 * Why `migratesFrom` cannot be the lineage of `id`, or null if it can. A
 * version migrates from an earlier version of its own family; a step into
 * another family is a migration, not lineage. See docs/spec/data-model.md
 * § Type migrations.
 */
export const lineageProblem = (id: string, migratesFrom: unknown): string | null => {
  if (migratesFrom === undefined) return null;
  const self = parseTypeId(id);
  const from = typeof migratesFrom === 'string' ? parseTypeId(migratesFrom) : null;
  if (!self || !from) {
    return `migratesFrom must be a versioned TypeId, e.g. "com.example.myapp/note@1".`;
  }
  if (from.baseId !== self.baseId || from.version >= self.version) {
    return `"${id}" cannot migrate from "${migratesFrom as string}": migratesFrom names an earlier version of the same family.`;
  }
  return null;
};

/**
 * Why `value` cannot name a type family, or null if it can. A family is a
 * bare `BaseId`; a versioned TypeId names one version and is refused with the
 * family to pass instead. See docs/spec/data-model.md § Types.
 */
export const familyIdProblem = (value: unknown, label: string): string | null => {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return `${label}: expected a non-empty baseId`;
  }
  if (value.includes('@')) {
    const parsed = parseTypeId(value);
    return parsed
      ? `${label}: "${value}" names one version; pass the family "${parsed.baseId}"`
      : `${label}: "${value}" is not a well-formed baseId (expected "baseId", with no "@version")`;
  }
  return null;
};
