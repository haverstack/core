/**
 * System family policies
 * -------------------------------------------------------
 * The rules a system family holds a scoped writer to on top of the
 * ordinary gates: who may write its Records at all, which content values
 * are the owner's alone to set, and what a create must already be able to
 * reach. One entry per family, read by every verb through the questions
 * below, so a rule reaches each verb that writes what it governs — create,
 * patchContent(), restoreVersion() and commitMigration() alike — rather
 * than only the ones that remembered to ask it.
 *
 * A family with no entry is ordinary. Grants on a family are refused
 * separately, at the write and at evaluation (UNGRANTABLE_SYSTEM_TYPES in
 * grants.ts), since a grant is not a scoped write.
 *
 * See docs/spec/access-control.md § Per-verb gates.
 */

import { baseIdOf } from '../schema.js';
import { bindingFieldsOf } from '../stack/identity-bindings.js';
import { SYSTEM_TYPES } from '../types/index.js';
import type { EntityId, TypeId } from '../types/index.js';

/**
 * Who may write a Record of a family, whatever its own `permissions` and
 * any grant say: anyone the ordinary write gate admits, the owner acting
 * alone, or the Group's admins and the owner.
 */
export type FamilyWriters = 'ordinary' | 'owner-alone' | 'group-managers';

type FamilyPolicy = {
  writers: FamilyWriters;
  /**
   * Content fields only the owner acting alone may set, and when: `any`
   * change, or only a value naming the owner's own DID.
   */
  ownerFields?: { fields: readonly string[]; when: 'any' | 'owner-did'; message: string };
  /**
   * A content field naming a file a non-owner create must already be able
   * to read through some other Record — see docs/spec/attachments.md
   * § Creating `_attachment@1` records directly.
   */
  createNamesFile?: string;
  /**
   * Whether `relationship` associations are a roster naming Entities
   * rather than references to readable Records, and so carry no
   * reference gate — see docs/spec/access-control.md § Reference-creation gating.
   */
  rosterAssociations?: boolean;
};

const ORDINARY: FamilyPolicy = { writers: 'ordinary' };

const POLICIES: ReadonlyMap<string, FamilyPolicy> = new Map<string, FamilyPolicy>([
  // Authority itself: see docs/spec/access-control.md § What a grant covers.
  [SYSTEM_TYPES.GRANT, { writers: 'owner-alone' }],
  [SYSTEM_TYPES.INSTALL, { writers: 'owner-alone' }],
  // Managed, not merely written: see docs/spec/identity.md § Group.
  [SYSTEM_TYPES.GROUP, { writers: 'group-managers', rosterAssociations: true }],
  // See docs/spec/identity.md § DID bindings.
  [
    SYSTEM_TYPES.APP,
    {
      writers: 'ordinary',
      ownerFields: {
        fields: bindingFieldsOf(SYSTEM_TYPES.APP),
        when: 'any',
        message: 'Only the stack owner may set an _app record’s did or appId',
      },
    },
  ],
  [
    SYSTEM_TYPES.ENTITY,
    {
      writers: 'ordinary',
      ownerFields: {
        fields: ['did'],
        when: 'owner-did',
        message: 'Only the stack owner may claim the owner’s own did',
      },
    },
  ],
  [SYSTEM_TYPES.ATTACHMENT, { writers: 'ordinary', createNamesFile: 'fileId' }],
]);

/** The policy a Record of `typeId` is held to. */
export const familyPolicy = (typeId: TypeId): FamilyPolicy =>
  POLICIES.get(baseIdOf(typeId)) ?? ORDINARY;

/**
 * The refusal a write owes when it moves content only the owner acting
 * alone may set, or null when it moves none. Compared value-wise between
 * `before` (absent at create) and `after`, so re-sending a value a Record
 * already holds claims nothing.
 */
export const ownerFieldRefusal = (
  typeId: TypeId,
  before: Record<string, unknown> | undefined,
  after: Record<string, unknown>,
  ownerEntityId: EntityId,
): string | null => {
  const rule = familyPolicy(typeId).ownerFields;
  if (!rule) return null;
  const moved = rule.fields.some(
    (field) =>
      after[field] !== before?.[field] && (rule.when === 'any' || after[field] === ownerEntityId),
  );
  return moved ? rule.message : null;
};
