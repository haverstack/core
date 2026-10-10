/**
 * Wire parsers
 * -------------------------------------------------------
 * Wire JSON to core's domain objects, for responses only. This adapter
 * is a client: it never reads a request body, so the identity fields a
 * server assigns from the session — createdBy and updatedBy — arrive
 * already decided, and parsing them is reading an answer rather than
 * accepting a claim. See docs/spec/wire-format.md § Records.
 */

import type {
  RecordJournalEntry,
  Actor,
  ChangeActor,
  StackRecord,
  StackType,
  TypeSchema,
  RecordVersion,
  RecordChange,
} from '@haverstack/core';
import type {
  WireActor,
  WireChangeActor,
  WireRecord,
  WireType,
  WireVersion,
  WireRecordChange,
  WireJournalEntry,
} from '@haverstack/wire-types';

const parseActor = (raw: WireActor): Actor => ({
  subjectId: raw.subjectId,
  ...(raw.principalId != null && { principalId: raw.principalId }),
});

const parseChangeActor = (raw: WireChangeActor): ChangeActor => ({
  ...parseActor(raw),
  ...(raw.appId != null && { appId: raw.appId }),
});

export const parseRecord = (raw: WireRecord): StackRecord => {
  const record: StackRecord = {
    id: raw.id,
    typeId: raw.typeId,
    createdAt: new Date(raw.createdAt),
    updatedAt: new Date(raw.updatedAt),
    content: raw.content,
    version: raw.version,
  };
  if (raw.parentId != null) record.parentId = raw.parentId;
  if (raw.appId != null) record.appId = raw.appId;
  if (raw.createdBy != null) record.createdBy = parseActor(raw.createdBy);
  if (raw.updatedBy != null) record.updatedBy = parseActor(raw.updatedBy);
  if (raw.deletedAt != null) record.deletedAt = new Date(raw.deletedAt);
  if (raw.unlistedAt != null) record.unlistedAt = new Date(raw.unlistedAt);
  if (raw.permissions != null) record.permissions = raw.permissions;
  if (raw.associations != null) record.associations = raw.associations;
  return record;
};

export const parseType = (raw: WireType): StackType => {
  const t: StackType = {
    id: raw.id,
    baseId: raw.baseId,
    version: raw.version,
    name: raw.name,
    schema: raw.schema as TypeSchema,
    schemaHash: raw.schemaHash,
    createdAt: new Date(raw.createdAt),
  };
  if (raw.migratesFrom != null) t.migratesFrom = raw.migratesFrom;
  return t;
};

export const parseVersion = (raw: WireVersion): RecordVersion => {
  const v: RecordVersion = {
    version: raw.version,
    typeId: raw.typeId,
    content: raw.content,
    updatedAt: new Date(raw.updatedAt),
  };
  if (raw.createdBy != null) v.createdBy = parseActor(raw.createdBy);
  if (raw.updatedBy != null) v.updatedBy = parseActor(raw.updatedBy);
  return v;
};

/**
 * `previousParentId` is the one field read for presence rather than for
 * null: absent means this entry is not a reparent, while `null` means the
 * record moved out of the root. Every other nullable field on a response
 * collapses both to absent, which here would lose which one happened.
 */
export const parseJournalEntry = (raw: WireJournalEntry): RecordJournalEntry => {
  const e: RecordJournalEntry = {
    seq: raw.seq,
    at: new Date(raw.at),
    kind: raw.kind,
    ops: [...raw.ops],
    version: raw.version,
    typeId: raw.typeId,
  };
  if (raw.parentId != null) e.parentId = raw.parentId;
  if (raw.actor != null) e.actor = parseChangeActor(raw.actor);
  if (raw.previousParentId !== undefined) e.previousParentId = raw.previousParentId;
  if (raw.associations != null) e.associations = raw.associations;
  return e;
};

export const parseChange = (raw: WireRecordChange): RecordChange => {
  const change: RecordChange = {
    kind: raw.kind,
    // Copied, so a frame's array is never shared with the parsed change a
    // handler receives.
    ops: [...raw.ops],
    recordId: raw.recordId,
    typeId: raw.typeId,
    version: raw.version,
    updatedAt: new Date(raw.updatedAt),
  };
  if (raw.actor != null) change.actor = parseChangeActor(raw.actor);
  if (raw.cursor != null) change.cursor = raw.cursor;
  // A purge carries nothing about the record it destroyed. A conformant
  // server sends neither field on one; dropping them here means a server
  // that does cannot hand a subscriber the copy the verb exists to erase.
  if (raw.kind === 'purged') return change;
  if (raw.parentId != null) change.parentId = raw.parentId;
  if (raw.associationsAdded != null) change.associationsAdded = raw.associationsAdded;
  if (raw.associationsRemoved != null) change.associationsRemoved = raw.associationsRemoved;
  if (raw.record != null) change.record = parseRecord(raw.record);
  return change;
};
