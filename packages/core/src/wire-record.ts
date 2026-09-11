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
import { StackQueryError, StackValidationError } from './errors.js';
import type { BackdatableCreateRecordOptions } from './stack.js';
import { RECORD_CHANGE_KEYS } from './types.js';
import type {
  Association,
  EntityId,
  Permission,
  RecordChanges,
  TokenSession,
  TypeId,
} from './types.js';

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

/**
 * Read a `PATCH /records/:id` body as a change set. The envelope's keys
 * are native aspects, so an unrecognized one is a client reaching for
 * something this endpoint does not have — refused rather than ignored,
 * since a dropped `permissions` silently fails to share and a dropped
 * `unlisted` silently fails to publish.
 *
 * `StackQueryError` (400) for a key that addresses nothing and
 * `StackValidationError` (422) for one whose value is the wrong shape —
 * the same split every other write endpoint makes. Content keys are
 * `Stack`'s to judge, so `contentPatch` is checked for being an object and
 * nothing more.
 * See docs/spec/wire-format.md § Records.
 */
export function changesFromWireBody(body: unknown): RecordChanges {
  const envelope = requireBody(body);

  const unknown = Object.keys(envelope).filter(
    (key) => !(RECORD_CHANGE_KEYS as readonly string[]).includes(key),
  );
  if (unknown.length > 0) {
    throw new StackQueryError(
      `Unknown change-set key${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}. ` +
        `A change set names one or more of: ${RECORD_CHANGE_KEYS.join(', ')}.`,
    );
  }

  const changes: RecordChanges = {};

  if (envelope.contentPatch !== undefined) {
    const patch = envelope.contentPatch;
    if (typeof patch !== 'object' || patch === null || Array.isArray(patch))
      fieldError('contentPatch', 'contentPatch must be an object');
    changes.contentPatch = patch as Record<string, unknown | null>;
  }

  // The one key `null` is a value for rather than a removal spelling: it
  // is the root, the same sentinel `?parentId=null` carries.
  if (envelope.parentId !== undefined) {
    const parentId = envelope.parentId;
    if (parentId !== null && typeof parentId !== 'string')
      fieldError('parentId', 'parentId must be a string or null');
    changes.parentId = parentId;
  }

  const permissions = optionalArray<Permission>(envelope, 'permissions');
  if (permissions !== undefined) changes.permissions = permissions;
  const associations = optionalArray<Association>(envelope, 'associations');
  if (associations !== undefined) changes.associations = associations;

  if (envelope.unlisted !== undefined) {
    if (typeof envelope.unlisted !== 'boolean')
      fieldError('unlisted', 'unlisted must be a boolean');
    changes.unlisted = envelope.unlisted;
  }

  // Every key was absent. Refused here rather than left to mutate(), so a
  // server answers 400 without a storage round trip; mutate() refuses it
  // again for callers that never went through the wire.
  if (Object.keys(changes).length === 0) {
    throw new StackQueryError(
      `An empty change set addresses nothing. Name one or more of: ${RECORD_CHANGE_KEYS.join(', ')}.`,
    );
  }

  return changes;
}
