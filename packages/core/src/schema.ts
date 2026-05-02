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

import type { TypeSchema, FieldDef } from './types.js';

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
 * Check whether a candidate schema satisfies a required schema.
 *
 * A candidate is compatible if it contains all *required* fields from
 * the required schema with matching kinds. Optional fields in the
 * required schema are ignored. Array and object fields are matched
 * shallowly — only the top-level kind is checked.
 *
 * Apps that need precise type matching should compare typeIds directly.
 * isCompatible() is for duck-typed consumption across types.
 */
export const isCompatible = (candidateSchema: TypeSchema, requiredSchema: TypeSchema): boolean => {
  return Object.entries(requiredSchema).every(([key, def]) => {
    if (!def.required) return true;
    const field = candidateSchema[key];
    return field !== undefined && field.kind === def.kind;
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
