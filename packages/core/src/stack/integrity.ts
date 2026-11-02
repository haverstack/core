/**
 * Write invariants
 * -------------------------------------------------------
 * The integrity rules a Stack write owes whoever makes it — immutable
 * fields, DID and appId bindings, containment, attachment metadata and a
 * group's admin roster. They bind every requester, the stack owner
 * included, which is why they live beneath `ScopedStack`'s permission
 * gates rather than among them. Each reads unscoped: through the Stack it
 * is handed, or a by-id `read` straight from its adapter.
 */

import { hasGroupAdmin, isGroupRecord } from '../access.js';
import type { RecordResolver } from '../access.js';
import { ARGUMENTS_INVALID, StackConflictError, StackValidationError } from '../errors.js';
import { filtersContent } from '../query-validation.js';
import { associationIdentical } from '../associations/identity.js';
import { validateRecordId } from './record-id.js';
import { baseIdOf } from '../schema.js';
import { findFirstMatch } from './reads.js';
import { SYSTEM_TYPES } from '../types/index.js';
import type {
  Association,
  AttachmentContent,
  DataAssociation,
  RecordId,
  StackRecord,
  TypeId,
} from '../types/index.js';
import type { Stack } from './stack.js';

// -------------------------------------------------------
// Immutable fields
// -------------------------------------------------------

/**
 * Each family's fields that no write may move once they hold a value. One
 * rule for all of them; why each field is here belongs to its own spec.
 * See docs/spec/data-model.md § Immutable fields.
 */
const IMMUTABLE_FIELDS: ReadonlyMap<string, readonly string[]> = new Map([
  [SYSTEM_TYPES.CONFIG, ['ownerEntityId']],
  [SYSTEM_TYPES.ENTITY, ['did']],
  [SYSTEM_TYPES.APP, ['did', 'appId']],
  [SYSTEM_TYPES.INSTALL, ['appId']],
  [SYSTEM_TYPES.ATTACHMENT, ['fileId', 'mimeType', 'size']],
]);

/**
 * Refuse a write whose resulting content moves or clears a field the
 * record holds. Asked over both families a write touches, so leaving a
 * family sheds nothing. See docs/spec/data-model.md § Immutable fields.
 */
export function checkImmutableFields(
  fromTypeId: TypeId,
  toTypeId: TypeId,
  existing: Record<string, unknown>,
  next: Record<string, unknown>,
): void {
  const families = new Set([baseIdOf(fromTypeId), baseIdOf(toTypeId)]);
  for (const family of families) {
    for (const field of IMMUTABLE_FIELDS.get(family) ?? []) {
      const held = existing[field];
      if (held === undefined || held === '' || next[field] === held) continue;
      throw new StackConflictError(`Cannot change ${family}.${field}: it is immutable once set.`);
    }
  }
}

// -------------------------------------------------------
// DID and appId bindings
// -------------------------------------------------------

/**
 * The binding fields an Actor is resolved *by*, which are unique per stack:
 * a second claimant leaves the lookup ambiguous. `_app.appId` is
 * deliberately absent — nothing resolves by it, and a new key's card must
 * repeat it. See docs/spec/identity.md § DID bindings.
 */
const UNIQUE_BINDING_FIELDS: ReadonlyMap<string, readonly ('did' | 'appId')[]> = new Map([
  [SYSTEM_TYPES.APP, ['did'] as const],
  [SYSTEM_TYPES.ENTITY, ['did'] as const],
  // One install answers for each app; see docs/spec/apps.md § The `_install` record.
  [SYSTEM_TYPES.INSTALL, ['appId'] as const],
]);

/**
 * Uniqueness for every unique binding field a write's content claims. A
 * value the record already held in the same family is no new claim, so
 * `prior` — the record as it stands, absent on create — exempts it.
 */
export async function checkBindingsUnique(
  stack: Stack,
  typeId: TypeId,
  content: Record<string, unknown>,
  prior?: StackRecord,
): Promise<void> {
  const family = baseIdOf(typeId);
  const held =
    prior && baseIdOf(prior.typeId) === family ? (prior.content as Record<string, unknown>) : {};
  for (const field of UNIQUE_BINDING_FIELDS.get(family) ?? []) {
    if (content[field] === held[field]) continue;
    await checkBindingUnique(stack, family, field, content[field], prior?.id);
  }
}

/**
 * Refuse a second card claiming a value an Actor is resolved by. A
 * property of the set rather than the value, so no schema can say it.
 * Read-then-write: two racing creates can both pass.
 * See docs/spec/identity.md § DID bindings.
 */
async function checkBindingUnique(
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

// -------------------------------------------------------
// Containment
// -------------------------------------------------------

/**
 * How far a `parentId` will walk a proposed ancestor chain before refusing
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
  validateRecordId(parentId, 'parentId');
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
 * mimeType belongs to the fileId: its first metadata record fixes it, and
 * a conflicting later one is refused — a clash with stored state, as a
 * binding's second claimant is. Best-effort against a racing first
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
    throw new StackConflictError(
      'mimeType conflicts with the mimeType already established for this fileId',
    );
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
  // One round trip per pointer, taken together: a write carries a
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

// -------------------------------------------------------
// Groups
// -------------------------------------------------------

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
