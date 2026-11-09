/**
 * The change journal: the per-record log of what each write moved.
 */

import type { AssociationChange } from './associations.js';
import type { ChangeKind, ChangeOp, ChangeActor } from './events.js';
import type { RecordId, TypeId } from './ids.js';

/**
 * The part of a change the record cannot report once the write has
 * landed: which aspects moved, who moved them, and what an association
 * mutation displaced. The adapter stamps the rest of the entry from the
 * row it just wrote, so the two never drift. See docs/spec/journal.md.
 */
export type JournalEntryInput = {
  ops: ChangeOp[];
  kind: ChangeKind;
  actor?: ChangeActor;
  /** The container a move took the record out of, `null` for the root. */
  previousParentId?: RecordId | null;
  /**
   * What an association mutation moved, one tagged edit per association,
   * with `previous` beside whatever displaced it.
   * See docs/spec/journal.md § The entry.
   */
  associations?: AssociationChange[];
};

/**
 * One durable entry in a record's change journal. Envelope only — content
 * lives on a RecordVersion. See docs/spec/journal.md § Ordering for why
 * `seq` is the only ordering.
 */
export type RecordJournalEntry = JournalEntryInput & {
  seq: number;
  /** When the entry was appended — not the record's `updatedAt`, which an association change leaves alone. */
  at: Date;
  /** The version this change produced — unchanged on an op that doesn't bump; see ChangeOp. */
  version: number;
  typeId: TypeId;
  /** Where the record sat after the change, absent for the root. */
  parentId?: RecordId;
};

/** Window into a record's journal. Omitting both reads the whole log, oldest first. */
export type JournalQuery = {
  /** Entries after this seq, exclusive. */
  afterSeq?: number;
  limit?: number;
};
