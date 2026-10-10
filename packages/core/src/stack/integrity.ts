/**
 * Write invariants
 * -------------------------------------------------------
 * The integrity rules a Stack write owes whoever makes it — DID and appId
 * bindings, containment, attachment metadata, `_config` ownership and a
 * group's admin roster. They bind every requester, the stack owner
 * included, which is why they live beneath `ScopedStack`'s permission
 * gates rather than among them. Each reads through the unscoped Stack it
 * is handed.
 */

import { hasGroupAdmin } from '../access.js';
import { ARGUMENTS_INVALID, StackConflictError, StackValidationError } from '../errors.js';
import { bindingFieldsOf, uniqueBindingFieldsOf } from '../identity-bindings.js';
import { filtersContent } from '../query-validation.js';
import { associationIdentical, isGroupRecord } from '../record-changes.js';
import { validateParentId } from '../record-id.js';
import { baseIdOf } from '../schema.js';
import { findFirstMatch } from '../stack-reads.js';
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
 * Bindings across a migration. `content` is a full replacement, so every
 * binding field either keeps its value, moves to a new one, or is shed by
 * omission — and immutability refuses the last two. Asked across the
 * union of both families' binding fields, so a card can neither shed its
 * DID by migrating out of `_entity`/`_app` nor pick one up on the way in.
 *
 * Uniqueness is asked only of the destination family, excluding the
 * record itself. See docs/spec/identity.md § DID bindings.
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
 * A unique binding field is what a lookup resolves *by* — an Actor's
 * `principalId` by `_app.did`, its `subjectId` by `_entity.did`. Two cards
 * claiming one value would leave that lookup without a single answer, and
 * ambiguity is all an impersonating card needs. Enforced here rather than
 * by schema, since uniqueness is a property of the set, not of the value.
 *
 * Read-then-write, so two creates racing on one value can both pass:
 * closing that means a unique index over a JSON field, which is a
 * decision about where uniqueness lives rather than a local fix.
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
 * A binding is permanent once made: uniqueness stops a second card
 * claiming a value, but only immutability stops an existing card being
 * moved onto one, which reaches the same impersonation by another route.
 * Adopting a value is therefore a one-way step, and a subject whose key
 * changes gets a new card — matching identity.md's deferral of key
 * rotation, where a new key is a new identity rather than the same one
 * relabelled. See docs/spec/identity.md § DID bindings.
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
 * The checks a *caller-named* destination owes, before the cycle walk:
 * `parentId` is a real, well-formed record id. Format first, so a
 * malformed one is a 400 naming the problem rather than a read that
 * cannot match. Existence closes the gap between the owner path and a
 * non-owner's, where canReadReferent() already refuses a parent that
 * isn't there.
 *
 * restoreVersion() deliberately does not call this — see its own comment.
 * See docs/spec/data-model.md § Reparenting.
 */
export async function assertParentExists(
  stack: Stack,
  id: string,
  parentId: string,
): Promise<void> {
  validateParentId(parentId);
  if (!(await stack.get(parentId, { includeDeleted: true }))) {
    throw new StackConflictError(
      `Cannot parent record "${id}" to "${parentId}": no such record. A container has to ` +
        'exist when it is named.',
    );
  }
}

/**
 * Refuse an edge that would make a record its own ancestor — asked at
 * every site that adds one. Nothing downstream (a generator deriving a
 * page path, a folder view) is written to survive a cycle.
 *
 * Walks the unscoped Stack: a walk that skipped the links a
 * requester cannot read would let a cycle be assembled through them and
 * break the invariant for every reader.
 *
 * Read-then-write, so two moves racing on opposite ends of one chain can
 * both pass — the same deferral as checkBindingUnique() above, since
 * closing it would put a graph constraint in the storage contract.
 * Consumers walking `parentId` should carry a visited set rather than
 * trust this alone. See docs/spec/data-model.md § Reparenting.
 */
export async function assertNoParentCycle(
  stack: Stack,
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
    cursor = (await stack.get(cursor, { includeDeleted: true }))?.parentId;
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
 * mimeType is a property of the fileId, not the uploader's perspective:
 * the first metadata record for a fileId fixes it, and a conflicting
 * later upload is rejected. See docs/spec/attachments.md § The
 * `_attachment` record type.
 *
 * Best-effort by construction — check-then-create with no storage-level
 * uniqueness behind it, so two racing first uploads can both land on a
 * concurrent server. What survives that race is the *resolution*:
 * getAttachmentRecords() returns the candidates in the same total order
 * a server serving Content-Type applies, so both sides name the same
 * winner however many records exist.
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
 * An attachment association's `attachmentRecordId` names an `_attachment`
 * record for the same `fileId` — checked here so a reference can't be
 * annotated with an unrelated record's filename.
 *
 * Best-effort, like the mimeType check above: the named record can be
 * deleted afterwards, so every reader of the field falls back rather than
 * trusting it. `stored` is what the record already holds, asked so a
 * change set restating an association is never refused for a pointer the
 * record has carried since before the named record was deleted.
 * See docs/spec/attachments.md § Naming the upload a reference came from.
 */
export async function checkAttachmentAssociationPointers(
  stack: Stack,
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
    pointed.map(({ attachmentRecordId }) =>
      stack.get(attachmentRecordId, { includeDeleted: true }),
    ),
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
    // One message for every way of failing: a missing record and a record
    // for other bytes must not be distinguishable, or this becomes an
    // existence oracle for records the caller cannot read. A write that
    // succeeds does confirm the record it names, but only to a caller who
    // already has file access for those bytes.
    // See the anti-oracle rule in docs/spec/attachments.md.
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
 * filename is the only mutable field on an `_attachment@1` record; fileId,
 * size and mimeType are immutable, and the correction flow is delete +
 * re-upload. `violates` decides what counts as touching one, because the
 * two write shapes disagree: a patch names only what it changes, while a
 * migration replaces content wholesale and necessarily re-sends all three.
 *
 * Repointing `fileId` is the one that matters most: an `_attachment@1`
 * record naming a fileId is what canAccessFile()'s uploader clause reads,
 * so moving an existing record onto another file's hash is a route to
 * bytes the record's author never uploaded.
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
 * Refuse a write that would leave a `_group` Record with no `admin` on its
 * roster. Asked of the roster the write would *produce*, which is the
 * whole of the self-removal question: an admin removing themselves passes
 * while another remains and is refused when they are the last, without
 * either case naming who is going.
 *
 * An integrity constraint on the Record, not a permission question, so it
 * lives here rather than in `ScopedStack` and binds every requester — the
 * stack owner included. See docs/spec/identity.md § Group.
 */
export function assertGroupAdminRemains(record: StackRecord, next: DataAssociation[]): void {
  if (!isGroupRecord(record)) return;
  if (hasGroupAdmin(next)) return;
  throw new StackConflictError(
    `Cannot leave group "${record.id}" without an admin: a _group record's roster keeps at ` +
      'least one `admin` relationship association. Name the incoming admin in the same write.',
  );
}
