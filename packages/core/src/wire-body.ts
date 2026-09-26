/**
 * Stack — Wire Request Bodies
 * -------------------------------------------------------
 * The JSON bodies of the endpoints core specifies but runs no server for:
 * the auth handshake, `PATCH /entity`, `POST /types` and
 * `POST /records/:id/migrate`. Each parser names every key its endpoint
 * defines, so a server refuses the rest without keeping its own copy of
 * the list — a copy that drifts the first time core adds a field.
 *
 * The error split is the one `POST /records` makes: a body that is not an
 * object, carries a key its endpoint does not define, or lacks a field the
 * endpoint requires is not that request at all, so it is
 * `StackBadRequestError` (400). A known field whose value is the wrong
 * type is `StackValidationError` (422), which carries the field's path.
 * Beyond type, values are `Stack`'s to judge — a schema's legality, a
 * DID's form — so judging them here would let two answers drift.
 * See docs/spec/wire-format.md § Unrecognized input.
 */

import { StackBadRequestError, StackValidationError } from './errors.js';
import type { DefineTypeOptions } from './stack.js';
import type { StackType, TypeId, TypeSchema } from './types.js';

export function requireBody(body: unknown, label: string): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body))
    throw new StackBadRequestError(`Invalid ${label}: expected an object`);
  return body as Record<string, unknown>;
}

/**
 * The refusal a present field earns when its value is the wrong shape.
 * `StackValidationError` because the failure names a field, and only that
 * class carries the path.
 */
export function fieldError(path: string, message: string): never {
  throw new StackValidationError([{ path, message }]);
}

/** A body carrying only `keys`; anything else is refused rather than ignored. */
function requireKnownBody(
  body: unknown,
  keys: readonly string[],
  label: string,
): Record<string, unknown> {
  const obj = requireBody(body, label);
  const unknown = Object.keys(obj).filter((key) => !keys.includes(key));
  if (unknown.length > 0)
    throw new StackBadRequestError(
      `Unknown key${unknown.length > 1 ? 's' : ''} in ${label}: ${unknown.join(', ')}`,
    );
  return obj;
}

function requiredString(body: Record<string, unknown>, key: string, label: string): string {
  const value = body[key];
  if (value === undefined) throw new StackBadRequestError(`Invalid ${label}: ${key} is required`);
  if (typeof value !== 'string') fieldError(key, `${key} must be a string`);
  return value;
}

function requiredObject(
  body: Record<string, unknown>,
  key: string,
  label: string,
): Record<string, unknown> {
  const value = body[key];
  if (value === undefined) throw new StackBadRequestError(`Invalid ${label}: ${key} is required`);
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    fieldError(key, `${key} must be an object`);
  return value as Record<string, unknown>;
}

// -------------------------------------------------------
// POST /auth/challenge, POST /auth/token
// -------------------------------------------------------

export type WireAuthChallengeRequest = { did: string };
export type WireAuthTokenRequest = { did: string; nonce: string; signature: string };

/**
 * Parse a `POST /auth/challenge` body. Whether `did` is a DID this server
 * can verify is the handshake's `invalid_did`, not a parse failure.
 * See docs/spec/wire-format.md § The handshake.
 */
export function parseAuthChallengeBody(body: unknown): WireAuthChallengeRequest {
  const label = 'auth challenge body';
  const b = requireKnownBody(body, ['did'], label);
  return { did: requiredString(b, 'did', label) };
}

/**
 * Parse a `POST /auth/token` body. The three fields are the only client
 * input the signing payload takes, so a fourth — a `subjectId`, say — is
 * refused rather than read as a request the handshake cannot grant.
 */
export function parseAuthTokenBody(body: unknown): WireAuthTokenRequest {
  const label = 'auth token body';
  const b = requireKnownBody(body, ['did', 'nonce', 'signature'], label);
  return {
    did: requiredString(b, 'did', label),
    nonce: requiredString(b, 'nonce', label),
    signature: requiredString(b, 'signature', label),
  };
}

// -------------------------------------------------------
// PATCH /entity
// -------------------------------------------------------

/** A content patch for the owner entity, in the shape `patchContent()` takes. */
export type WireEntityPatch = { contentPatch: Record<string, unknown | null> };

/** Parse a `PATCH /entity` body. See docs/spec/wire-format.md § Entity. */
export function parseEntityPatchBody(body: unknown): WireEntityPatch {
  const label = 'entity body';
  const b = requireKnownBody(body, ['contentPatch'], label);
  return { contentPatch: requiredObject(b, 'contentPatch', label) };
}

// -------------------------------------------------------
// POST /types
// -------------------------------------------------------

/**
 * Every key a wire Type carries — a `StackType`'s, so a new field fails to
 * compile here until it is listed. A client posts the whole Type, and the
 * derived keys are accepted and ignored since `defineType()` computes them.
 */
const WIRE_TYPE_KEYS: readonly string[] = Object.keys({
  id: true,
  baseId: true,
  version: true,
  name: true,
  schema: true,
  schemaHash: true,
  migratesFrom: true,
  createdAt: true,
} satisfies Record<keyof StackType, true>);

/**
 * Parse a `POST /types` body into the options `defineType()` takes.
 * `schema` passes through unexamined: its legality is `defineType()`'s to
 * report, field by field. See docs/spec/wire-format.md § Types.
 */
export function parseTypeBody(body: unknown): DefineTypeOptions {
  const label = 'type body';
  const b = requireKnownBody(body, WIRE_TYPE_KEYS, label);
  const id = requiredString(b, 'id', label);
  const name = requiredString(b, 'name', label);
  if (b.schema === undefined)
    throw new StackBadRequestError(`Invalid ${label}: schema is required`);
  const options: DefineTypeOptions = { id, name, schema: b.schema as TypeSchema };
  if (b.migratesFrom !== undefined) {
    if (typeof b.migratesFrom !== 'string')
      fieldError('migratesFrom', 'migratesFrom must be a string');
    options.migratesFrom = b.migratesFrom;
  }
  return options;
}

// -------------------------------------------------------
// POST /records/:id/migrate
// -------------------------------------------------------

/** The two arguments `commitMigration()` takes after the record id. */
export type WireMigrationRequest = { toTypeId: TypeId; content: Record<string, unknown> };

/**
 * Parse a `POST /records/:id/migrate` body. `content` is the whole
 * post-migration content, validated by `commitMigration()` against
 * `toTypeId`'s schema. See docs/spec/wire-format.md § Migration commit.
 */
export function parseMigrationBody(body: unknown): WireMigrationRequest {
  const label = 'migration body';
  const b = requireKnownBody(body, ['toTypeId', 'content'], label);
  return {
    toTypeId: requiredString(b, 'toTypeId', label),
    content: requiredObject(b, 'content', label),
  };
}
