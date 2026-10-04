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

import { SYSTEM_TYPES } from './types.js';

/**
 * Content fields that are lookup keys rather than display values: a card
 * claims one, and something later resolves through it. Every one of them is
 * immutable once set. See docs/spec/identity.md § DID bindings.
 */
/** A content field something resolves through. */
export type BindingField = 'did' | 'appId';

const BINDING_FIELDS: ReadonlyMap<string, readonly BindingField[]> = new Map([
  [SYSTEM_TYPES.APP, ['did', 'appId'] as const],
  [SYSTEM_TYPES.ENTITY, ['did'] as const],
  [SYSTEM_TYPES.INSTALL, ['appId'] as const],
]);

/**
 * The subset that is additionally unique per stack: the fields something
 * resolves *by*. An Actor's `principalId` finds its card by `_app.did` and
 * its `subjectId` by `_entity.did`, so a second card claiming either leaves
 * that lookup without a single answer — and ambiguity is all an
 * impersonating card needs.
 *
 * `_app.appId` is deliberately absent. Nothing resolves a card by it — the
 * cross-check reaches the card by `did` and only compares `appId` — so
 * uniqueness would buy no disambiguation, while forbidding the second card
 * key rotation is supposed to produce: `appId` is required, so a
 * replacement card for the same software necessarily repeats it. Moving one
 * card onto another's `appId` is what immutability already refuses.
 * See docs/spec/identity.md § DID bindings.
 */
const UNIQUE_BINDING_FIELDS: ReadonlyMap<string, readonly BindingField[]> = new Map([
  [SYSTEM_TYPES.APP, ['did'] as const],
  [SYSTEM_TYPES.ENTITY, ['did'] as const],
  // One install answers for each app; see docs/spec/apps.md § The `_install` record.
  [SYSTEM_TYPES.INSTALL, ['appId'] as const],
]);

export const bindingFieldsOf = (family: string): readonly BindingField[] =>
  BINDING_FIELDS.get(family) ?? [];

export const uniqueBindingFieldsOf = (family: string): readonly BindingField[] =>
  UNIQUE_BINDING_FIELDS.get(family) ?? [];
