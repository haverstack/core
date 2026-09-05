/**
 * Stack — Wire Record Bodies
 * -------------------------------------------------------
 * `POST /records` is the one endpoint where a client sends a whole record
 * and the server may trust only part of it. This module turns that body
 * into the arguments `ScopedStack.create()` takes, so the disposition of
 * each field — stamped, conditionally dropped, forwarded — is structural
 * rather than a property of how carefully a route was written. Which field
 * gets which is not derivable from its name, and the rules are normative
 * for servers in other languages, so they live in the spec rather than
 * here: docs/spec/wire-format.md § Records.
 */

import { isOwnerActingAlone } from './access.js';
import { StackQueryError, StackValidationError } from './stack.js';
import type { BackdatableCreateRecordOptions } from './stack.js';
import type { Association, EntityId, Permission, TokenSession, TypeId } from './types.js';

/**
 * A `POST /records` body as the three arguments `ScopedStack.create()`
 * takes. Not spread-ready, so a call site reads as three deliberate things.
 */
export type WireCreateRequest = {
  typeId: TypeId;
  content: Record<string, unknown>;
  /** Omitted, not optional: a caller cannot forward what the type lacks. */
  options: Omit<BackdatableCreateRecordOptions, 'entityId' | 'principalId'>;
};

function requireBody(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body))
    throw new StackQueryError('Invalid record body: expected an object');
  return body as Record<string, unknown>;
}

/**
 * The refusal a present field earns when its value is the wrong shape.
 * `StackValidationError` because the failure names a field of the record
 * being written, and only that class carries the path.
 */
function fieldError(path: string, message: string): never {
  throw new StackValidationError([{ path, message }]);
}

function optionalString(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') fieldError(key, `${key} must be a string`);
  return value;
}

function optionalArray<T>(body: Record<string, unknown>, key: string): T[] | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) fieldError(key, `${key} must be an array`);
  return value as T[];
}

/**
 * A wire date for one of the owner-only clock fields. An `Invalid Date`
 * must not reach `create()`: its `NaN` timestamp switches the id-skew
 * check off instead of failing it.
 */
function ownerDate(body: Record<string, unknown>, key: string): Date | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' && typeof value !== 'number')
    fieldError(key, `${key} must be a date string`);
  const date = new Date(value as string | number);
  if (isNaN(date.getTime())) fieldError(key, `Invalid ${key}: ${JSON.stringify(value)}`);
  return date;
}

/**
 * Read a `POST /records` body as a create. Takes the session rather than a
 * pre-computed boolean so the owner-acting-alone determination stays with
 * the rule that needs it.
 *
 * Beyond shape, values are `Stack`'s to judge — an id's legality, a
 * permission's contents, the content's schema — since judging them twice
 * would let the two answers drift.
 */
export function createOptionsFromWireRecord(
  body: unknown,
  session: TokenSession,
  ownerEntityId: EntityId,
): WireCreateRequest {
  const record = requireBody(body);

  const typeId = record.typeId;
  if (typeof typeId !== 'string' || typeId === '')
    throw new StackQueryError('Invalid record body: typeId is required');
  const content = record.content;
  if (typeof content !== 'object' || content === null || Array.isArray(content))
    throw new StackQueryError('Invalid record body: content is required');

  const options: WireCreateRequest['options'] = {};

  const id = optionalString(record, 'id');
  if (id !== undefined) options.id = id;
  const parentId = optionalString(record, 'parentId');
  if (parentId !== undefined) options.parentId = parentId;
  const appId = optionalString(record, 'appId');
  if (appId !== undefined) options.appId = appId;

  const permissions = optionalArray<Permission>(record, 'permissions');
  if (permissions !== undefined) options.permissions = permissions;
  const associations = optionalArray<Association>(record, 'associations');
  if (associations !== undefined) options.associations = associations;

  // Presence is the whole signal: an unlisted record is unlisted from
  // birth, so the timestamp a client sends has nothing to say.
  if (optionalString(record, 'unlistedAt') !== undefined) options.unlisted = true;

  if (isOwnerActingAlone(session, ownerEntityId)) {
    const createdAt = ownerDate(record, 'createdAt');
    if (createdAt !== undefined) options.createdAt = createdAt;
    const updatedAt = ownerDate(record, 'updatedAt');
    if (updatedAt !== undefined) options.updatedAt = updatedAt;
  }

  return { typeId, content: content as Record<string, unknown>, options };
}
