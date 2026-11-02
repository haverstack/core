/**
 * System field rules
 * -------------------------------------------------------
 * Which system-type content fields are bindings, which of those are
 * unique, and which fields are immutable, so the write checks and the
 * permission policy read one declaration. The `_attachment` mimeType
 * rule is not here: the first record for a fileId decides it, which no
 * per-field declaration says.
 *
 * See docs/spec/data-model.md § Immutable fields and
 * docs/spec/identity.md § DID bindings.
 */

import { SYSTEM_TYPES } from '../types/index.js';

/**
 * A field holds no value while absent or the empty string — how a required
 * string field says "none yet". See docs/spec/data-model.md § Immutable fields.
 */
export const isUnset = (value: unknown): boolean => value === undefined || value === '';

interface Binding {
  field: 'did' | 'appId';
  unique: boolean;
}

/**
 * Content fields that are lookup keys rather than display values: a card
 * claims one, and something later resolves through it. The unique ones are
 * those an Actor is resolved *by*; `_app.appId` is not, since nothing
 * resolves by it and a new key's card must repeat it.
 * See docs/spec/identity.md § DID bindings.
 */
const BINDINGS: ReadonlyMap<string, readonly Binding[]> = new Map([
  [
    SYSTEM_TYPES.APP,
    [
      { field: 'did', unique: true },
      { field: 'appId', unique: false },
    ],
  ],
  [SYSTEM_TYPES.ENTITY, [{ field: 'did', unique: true }]],
  // One install answers for each app; see docs/spec/apps.md § The `_install` record.
  [SYSTEM_TYPES.INSTALL, [{ field: 'appId', unique: true }]],
]);

export const bindingsOf = (family: string): readonly Binding[] => BINDINGS.get(family) ?? [];

export const bindingFieldsOf = (family: string): readonly ('did' | 'appId')[] =>
  bindingsOf(family).map(({ field }) => field);

/** The immutable fields that are not bindings. */
const FIXED_FIELDS: ReadonlyMap<string, readonly string[]> = new Map([
  [SYSTEM_TYPES.CONFIG, ['ownerEntityId']],
  [SYSTEM_TYPES.ATTACHMENT, ['fileId', 'mimeType', 'size']],
]);

/** See docs/spec/data-model.md § Immutable fields. */
export const immutableFieldsOf = (family: string): readonly string[] => [
  ...bindingFieldsOf(family),
  ...(FIXED_FIELDS.get(family) ?? []),
];
