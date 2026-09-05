/**
 * Stack — Wire Record Bodies
 * -------------------------------------------------------
 * `POST /records` is the one endpoint where a client sends a whole record
 * and the server may trust only part of it. This module turns that body
 * into the arguments `ScopedStack.create()` takes, so the three
 * dispositions the spec assigns its fields are structural rather than a
 * property of how carefully a route was written.
 *
 * The three, and why each field gets the one it does:
 *
 * - **Stamped.** `entityId`, `principalId`, `updatedBy`, `updatedVia` and
 *   `version` answer "who did this", so a self-reported value would defeat
 *   the attribution the model rests on. They are unreadable here rather
 *   than merely unread: `WireCreateRequest['options']` omits them, so no
 *   later edit can reintroduce one and no test would have to catch it.
 * - **Conditionally dropped.** `createdAt`/`updatedAt` are read only for
 *   the owner acting alone. Every client sends both on every create — a
 *   record body is a whole record — and `ScopedStack.create()` refuses
 *   backdating rather than ignoring it, so forwarding them unfiltered
 *   turns an ordinary grantee create into a `403`. The drop is by value:
 *   an absent key and an `undefined` one are both drops. A dropped field is
 *   never read, so a malformed one costs a non-owner nothing — refusing a
 *   date the server had already decided to ignore would fail a create over
 *   a field that could not have reached the record.
 * - **Forwarded.** `unlistedAt` becomes `unlisted: true` for every
 *   requester, because `ScopedStack.create()` gates it itself and owes a
 *   `403` rather than a silent drop. Opt-in fields can be forwarded; the
 *   fields above are on every body ever sent.
 *
 * Which field gets which is not derivable from its name, which is the
 * reason this is one export rather than a rule each server reimplements.
 * `deletedAt` falls outside all three: a create has no option it could
 * reach, so it is read no more than the stamped fields are.
 *
 * A record body's optional fields are absent or present, never `null` — a
 * null is refused rather than read as absent, since this codebase spends
 * that spelling on "remove this field" in a merge patch and one meaning per
 * spelling is what keeps the two endpoints readable side by side.
 * See docs/spec/wire-format.md § Records.
 */

import { isOwnerActingAlone } from './access.js';
import { StackQueryError, StackValidationError } from './stack.js';
import type { BackdatableCreateRecordOptions } from './stack.js';
import type { Association, EntityId, Permission, TokenSession, TypeId } from './types.js';

/**
 * What a `POST /records` body means, destructured into the three arguments
 * `ScopedStack.create()` takes. Returned as three fields rather than one
 * spread-ready object so a call site reads as three deliberate things.
 */
export type WireCreateRequest = {
  typeId: TypeId;
  content: Record<string, unknown>;
  /**
   * The identity fields are omitted rather than left optional: a caller
   * cannot forward what the type does not carry.
   */
  options: Omit<BackdatableCreateRecordOptions, 'entityId' | 'principalId'>;
};

function requireBody(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body))
    throw new StackQueryError('Invalid record body: expected an object');
  return body as Record<string, unknown>;
}

/**
 * A present field whose value is the wrong shape is refused, never dropped:
 * a silently ignored `id` mints a different record than the one the client
 * asked for, and a silently ignored `unlistedAt` publishes a record the
 * client meant to withhold. `StackValidationError` rather than
 * `StackQueryError` because the failure names a field of the record being
 * written, and only that class carries the path — the same reason
 * `Stack.create()` reports an id/`createdAt` disagreement as one.
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
 * must not reach `create()` as one: its `NaN` timestamp switches the
 * id-skew check off instead of failing it, so a malformed string would
 * disable a check rather than trip it.
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
 * Read a `POST /records` body as a create, applying the dispositions this
 * module's header describes. `session` and `ownerEntityId` are taken rather
 * than a pre-computed boolean so the owner-acting-alone determination stays
 * here alongside the rule that needs it.
 *
 * Throws `StackQueryError` (→ 400) when the body is not a create request at
 * all — no `typeId`, no `content` — and `StackValidationError` (→ 422),
 * naming the field, when the body is a create request carrying a field the
 * record cannot take. Values are otherwise judged by `Stack`, not here:
 * an id's legality, a permission's shape and the content's schema are all
 * its to refuse, and judging them twice would let the two answers drift.
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

  // Presence is the whole signal — the timestamp a client sends is the one
  // a create cannot honor anyway, since an unlisted record is unlisted
  // from birth.
  if (optionalString(record, 'unlistedAt') !== undefined) options.unlisted = true;

  if (isOwnerActingAlone(session, ownerEntityId)) {
    const createdAt = ownerDate(record, 'createdAt');
    if (createdAt !== undefined) options.createdAt = createdAt;
    const updatedAt = ownerDate(record, 'updatedAt');
    if (updatedAt !== undefined) options.updatedAt = updatedAt;
  }

  return { typeId, content: content as Record<string, unknown>, options };
}
