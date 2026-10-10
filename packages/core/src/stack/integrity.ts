/**
 * Write invariants
 * -------------------------------------------------------
 * The integrity rules a Stack write owes whoever makes it — DID and appId
 * bindings, containment, attachment metadata, `_config` ownership and a
 * group's admin roster. They bind every requester, the stack owner
 * included, which is why they live beneath `ScopedStack`'s permission
 * gates rather than among them. Each reads unscoped: through the Stack it
 * is handed, or a by-id `read` straight from its adapter.
 */

import { hasGroupAdmin } from '../access.js';
import type { RecordResolver } from '../access.js';
import { ARGUMENTS_INVALID, StackConflictError, StackValidationError } from '../errors.js';
import { bindingFieldsOf, uniqueBindingFieldsOf } from './identity-bindings.js';
import { filtersContent } from '../query-validation.js';
import { associationIdentical, isGroupRecord } from '../record-changes.js';
import { validateParentId } from './record-id.js';
import { baseIdOf } from '../schema.js';
import { findFirstMatch } from './reads.js';
import { SYSTEM_TYPES } from '../types/index.js';
import type {
  Association,
  AttachmentContent,
  DataAssociation,
  EntityId,
  RecordId,
  StackRecord,
  TypeId,
} from '../types/index.js';
import type { Stack } from './stack.js';

// -------------------------------------------------------
// DID and appId bindings
// -------------------------------------------------------

/** Uniqueness for every unique binding field a newly created card claims. */
export async function checkBindingsOnCreate(
  stack: Stack,
  typeId: TypeId,
  content: Record<string, unknown>,
): Promise<void> {
  const family = baseIdOf(typeId);
  for (const field of uniqueBindingFieldsOf(family)) {
    await checkBindingUnique(stack, family, field, content[field]);
  }
}

/**
 * Immutability for every binding field a patch touches, then uniqueness
 * for the subset that carries it. Fields absent from the patch carry no
 * new claim — a content patch is a merge, so an untouched binding is the one the
 * card already holds.
 */
export async function checkBindingsOnUpdate(
  stack: Stack,
  typeId: TypeId,
  id: RecordId,
  patch: Record<string, unknown | null>,
  existing: Record<string, unknown>,
  merged: Record<string, unknown>,
): Promise<void> {
  const family = baseIdOf(typeId);
  const unique = uniqueBindingFieldsOf(family);
  for (const field of bindingFieldsOf(family)) {
    if (!(field in patch)) continue;
    checkBindingImmutable(family, field, existing[field], merged[field]);
    if (unique.includes(field)) {
      await checkBindingUnique(stack, family, field, merged[field], id);
    }
  }
}

/**
 * Bindings across a migration, whose content replaces the old wholesale.
 * Immutability is asked over both families' binding fields, so a card can
 * neither shed a DID by migrating out nor pick one up on the way in;
 * uniqueness, of the destination only. See docs/spec/identity.md § DID bindings.
 */
export async function checkBindingsOnMigrate(
  stack: Stack,
  fromTypeId: TypeId,
  toTypeId: TypeId,
  id: RecordId,
  existing: Record<string, unknown>,
  content: Record<string, unknown>,
): Promise<void> {
  const fromFamily = baseIdOf(fromTypeId);
  const toFamily = baseIdOf(toTypeId);

  const checked = new Set<string>();
  for (const family of fromFamily === toFamily ? [fromFamily] : [fromFamily, toFamily]) {
    for (const field of bindingFieldsOf(family)) {
      if (checked.has(field)) continue;
      checked.add(field);
      checkBindingImmutable(family, field, existing[field], content[field]);
    }
  }

  for (const field of uniqueBindingFieldsOf(toFamily)) {
    await checkBindingUnique(stack, toFamily, field, content[field], id);
  }
}

/**
 * Refuse a second card claiming a value an Actor is resolved by. A
 * property of the set rather than the value, so no schema can say it.
 * Read-then-write: two racing creates can both pass.
 * See docs/spec/identity.md § DID bindings.
 */
export async function checkBindingUnique(
  stack: Stack,
  family: string,
  field: 'did' | 'appId',
  value: unknown,
  excludeId?: RecordId,
): Promise<void> {
  if (typeof value !== 'string' || value === '') return;

  const clash = await findFirstMatch(
    (q) => stack.query(q),
    {
      filter: {
        baseId: family,
        includeDeleted: true,
        includeUnlisted: true,
        ...(filtersContent(stack.capabilities) && { content: { [field]: value } }),
      },
    },
    (r) => r.id !== excludeId && (r.content as Record<string, unknown>)[field] === value,
  );
  if (clash) {
    throw new StackConflictError(`Another ${family} record already claims the ${field} "${value}"`);
  }
}

/**
 * A binding is permanent once made: uniqueness stops a second card claiming
 * a value, but only immutability stops an existing card being moved onto
 * one. A subject whose key changes gets a new card.
 * See docs/spec/identity.md § DID bindings.
 */
export function checkBindingImmutable(
  family: string,
  field: 'did' | 'appId',
  existing: unknown,
  next: unknown,
): void {
  if (typeof existing !== 'string' || existing === '') return;
  if (next === existing) return;
  throw new StackValidationError([
    {
      path: field,
      message: `${field} is immutable once set; register a new ${family} record instead`,
    },
  ]);
}

// -------------------------------------------------------
// Containment
// -------------------------------------------------------

/**
 * How far a change set's `parentId` will walk a proposed ancestor chain before refusing
 * the move. Bounds the reads one call can cost; a hierarchy deeper than
 * this is beyond what `parentId` is for. See docs/spec/data-model.md
 * § Reparenting.
 */
const MAX_PARENT_DEPTH = 64;

/**
 * A caller-named `parentId` is a well-formed id of a record that exists —
 * format first, so a malformed one is a 400 naming the problem. A restore
 * names no destination and does not ask this.
 * See docs/spec/data-model.md § Reparenting.
 */
export async function assertParentExists(
  read: RecordResolver,
  id: string,
  parentId: string,
): Promise<void> {
  validateParentId(parentId);
  if (!(await read(parentId))) {
    throw new StackConflictError(
      `Cannot parent record "${id}" to "${parentId}": no such record. A container has to ` +
        'exist when it is named.',
    );
  }
}

/**
 * Refuse an edge that would make a record its own ancestor. Walks with an
 * unscoped `read`, since links a requester cannot read could otherwise
 * close a cycle. Read-then-write, so racing moves can both pass.
 * See docs/spec/data-model.md § Reparenting.
 */
export async function assertNoParentCycle(
  read: RecordResolver,
  id: string,
  parentId: string,
): Promise<void> {
  let cursor: string | undefined = parentId;
  for (let depth = 0; cursor !== undefined; depth++) {
    if (cursor === id) {
      throw new StackConflictError(
        `Cannot parent record "${id}" to "${parentId}": it is a descendant of "${id}", ` +
          'and the move would make the record its own ancestor.',
      );
    }
    // The cap bounds work, and guarantees this terminates on a chain that
    // is already cyclic. It does not refuse the move: a chain this long is
    // past what the check can speak to, not evidence of a loop, and
    // refusing it would claim an invariant core does not maintain.
    if (depth >= MAX_PARENT_DEPTH) return;
    cursor = (await read(cursor))?.parentId;
  }
}

// -------------------------------------------------------
// Attachments
// -------------------------------------------------------

/**
 * The `_attachment@1` fields a write may not move, each with the message it
 * is refused by. Ordered as reported. See docs/spec/attachments.md § The
 * `_attachment` record type.
 */
const ATTACHMENT_IMMUTABLE_FIELDS = [
  ['mimeType', 'mimeType is immutable after creation; delete and re-upload to change it'],
  ['fileId', 'fileId is immutable'],
  ['size', 'size is immutable'],
] as const;

type AttachmentImmutableField = (typeof ATTACHMENT_IMMUTABLE_FIELDS)[number][0];

/**
 * mimeType belongs to the fileId: its first metadata record fixes it, and
 * a conflicting later one is refused. Best-effort against a racing first
 * upload; what survives the race is a deterministic winner. See
 * docs/spec/attachments.md § The `_attachment` record type.
 */
export async function checkAttachmentMimeTypeOnCreate(
  stack: Stack,
  content: AttachmentContent,
): Promise<void> {
  const { fileId, mimeType } = content;
  if (typeof fileId !== 'string') return; // schema validation already rejected this

  const existing = await stack.getAttachmentRecords(fileId);
  if (existing.length === 0) return;

  const establishedMimeType = existing[0].content.mimeType;
  if (mimeType !== establishedMimeType) {
    // Deliberately does not name the established mimeType — that would
    // confirm a guessed fileId's content type. See the anti-oracle rule
    // in docs/spec/attachments.md.
    throw new StackValidationError([
      {
        path: 'mimeType',
        message: 'mimeType conflicts with the mimeType already established for this fileId',
      },
    ]);
  }
}

/**
 * An `attachmentRecordId` must name an `_attachment` record for the same
 * `fileId`. Pointers already in `stored` are not re-asked, so restating an
 * association never fails for a record deleted since.
 * See docs/spec/attachments.md § Naming the upload a reference came from.
 */
export async function checkAttachmentAssociationPointers(
  read: RecordResolver,
  associations: Association[] | undefined,
  stored: Association[] = [],
): Promise<void> {
  const pointed = (associations ?? []).flatMap((association) =>
    association.kind === 'attachment' &&
    association.attachmentRecordId !== undefined &&
    !stored.some((a) => associationIdentical(a, association))
      ? [{ fileId: association.fileId, attachmentRecordId: association.attachmentRecordId }]
      : [],
  );
  // One round trip per pointer, taken together: a change set carries a
  // whole association list, and each pointer is an independent read.
  const named = await Promise.all(
    pointed.map(({ attachmentRecordId }) => read(attachmentRecordId)),
  );

  pointed.forEach(({ fileId }, i) => {
    const record = named[i];
    const content = record?.content as AttachmentContent | undefined;
    if (
      record &&
      baseIdOf(record.typeId) === SYSTEM_TYPES.ATTACHMENT &&
      content?.fileId === fileId
    ) {
      return;
    }
    // One message for every way of failing, so this is no existence oracle
    // for records the caller cannot read. See docs/spec/attachments.md
    // § Creating `_attachment@1` records directly.
    throw new StackValidationError(
      [
        {
          path: 'attachmentRecordId',
          message: 'attachmentRecordId must name an `_attachment` record for this fileId',
        },
      ],
      ARGUMENTS_INVALID,
    );
  });
}

/**
 * Refuse a write that moves an `_attachment@1` record's fileId, size or
 * mimeType. `violates` decides what counts as a move, since a patch names
 * only what it changes while a migration re-sends all three.
 * See docs/spec/attachments.md § The `_attachment` record type.
 */
export function assertAttachmentImmutable(
  violates: (field: AttachmentImmutableField) => boolean,
): void {
  const errors = ATTACHMENT_IMMUTABLE_FIELDS.filter(([field]) => violates(field)).map(
    ([path, message]) => ({ path, message }),
  );
  if (errors.length > 0) {
    throw new StackValidationError(errors);
  }
}

// -------------------------------------------------------
// Stack identity and groups
// -------------------------------------------------------

/**
 * `_config.entityId` defines stack ownership; neither patchContent() nor
 * restoreVersion() may change it. A conflict with stack integrity, not a
 * schema violation — hence StackConflictError. See docs/spec.md § The
 * `_config` record.
 */
export function checkConfigEntityIdUnchanged(
  existingEntityId: EntityId,
  newEntityId: EntityId,
): void {
  if (newEntityId !== existingEntityId) {
    throw new StackConflictError(
      'Cannot change _config.entityId: it defines stack ownership. ' +
        'Ownership transfer is not a supported operation.',
    );
  }
}

/**
 * Refuse a write that would leave a `_group` Record with no `admin`, asked
 * of the roster the write would produce. An integrity rule, not a
 * permission, so it binds the stack owner too.
 * See docs/spec/identity.md § Group.
 */
export function assertGroupAdminRemains(record: StackRecord, next: DataAssociation[]): void {
  if (!isGroupRecord(record)) return;
  if (hasGroupAdmin(next)) return;
  throw new StackConflictError(
    `Cannot leave group "${record.id}" without an admin: a _group record's roster keeps at ` +
      'least one `admin` relationship association. Name the incoming admin in the same write.',
  );
}
