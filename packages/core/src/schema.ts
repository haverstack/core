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
};

/**
 * Check whether a candidate field satisfies a required field, recursing
 * into array items and object properties.
 */
const isFieldCompatible = (candidate: FieldDef, required: FieldDef): boolean => {
  if (required.kind === 'array') {
    return candidate.kind === 'array' && isFieldCompatible(candidate.items, required.items);
  }
  if (required.kind === 'object') {
    return candidate.kind === 'object' && isCompatible(candidate.properties, required.properties);
  }
  if (candidate.kind === 'array' || candidate.kind === 'object') return false;
  return READ_COMPATIBLE[required.kind].includes(candidate.kind);
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
 * ignored. Array and object fields recurse into their items/properties.
 *
 * Apps that need precise type matching should compare typeIds directly.
 * isCompatible() is for duck-typed consumption across types.
 */
export const isCompatible = (candidateSchema: TypeSchema, requiredSchema: TypeSchema): boolean => {
  return Object.entries(requiredSchema).every(([key, def]) => {
    if (!def.required) return true;
    const field = candidateSchema[key];
    return field !== undefined && field.required === true && isFieldCompatible(field, def);
  });
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
