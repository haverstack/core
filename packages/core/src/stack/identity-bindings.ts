/**
 * DID bindings
 * -------------------------------------------------------
 * Which content fields are lookup keys rather than display values, and
 * which of those a stack resolves *by*. Every one is immutable once set;
 * the unique subset is additionally one-per-stack, because a lookup with
 * two answers is all an impersonating card needs.
 *
 * See docs/spec/identity.md § DID bindings.
 */

import { SYSTEM_TYPES } from '../types/index.js';

/**
 * Content fields that are lookup keys rather than display values: a card
 * claims one, and something later resolves through it. Every one of them is
 * immutable once set. See docs/spec/identity.md § DID bindings.
 */
const BINDING_FIELDS: ReadonlyMap<string, readonly ('did' | 'appId')[]> = new Map([
  [SYSTEM_TYPES.APP, ['did', 'appId'] as const],
  [SYSTEM_TYPES.ENTITY, ['did'] as const],
  [SYSTEM_TYPES.INSTALL, ['appId'] as const],
]);

/**
 * The subset that is additionally unique per stack: the fields an Actor is
 * resolved *by*, where a second claimant leaves the lookup ambiguous.
 * `_app.appId` is deliberately absent — nothing resolves by it, and a new
 * key's card must repeat it. See docs/spec/identity.md § DID bindings.
 */
const UNIQUE_BINDING_FIELDS: ReadonlyMap<string, readonly ('did' | 'appId')[]> = new Map([
  [SYSTEM_TYPES.APP, ['did'] as const],
  [SYSTEM_TYPES.ENTITY, ['did'] as const],
  // One install answers for each app; see docs/spec/apps.md § The `_install` record.
  [SYSTEM_TYPES.INSTALL, ['appId'] as const],
]);

export const bindingFieldsOf = (family: string): readonly ('did' | 'appId')[] =>
  BINDING_FIELDS.get(family) ?? [];

export const uniqueBindingFieldsOf = (family: string): readonly ('did' | 'appId')[] =>
  UNIQUE_BINDING_FIELDS.get(family) ?? [];
