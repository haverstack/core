/**
 * Change journal
 * -------------------------------------------------------
 * `GET /records/:id/journal`: the per-record log of what each write did.
 * See docs/spec/wire-format.md § Journal.
 */

import type { AssociationChange, ChangeKind, ChangeOp, RecordJournalEntry } from '@haverstack/core';
import { serializeChangeActor, type WireChangeActor } from './records.js';

/**
 * Every field a `RecordJournalEntry` holds, since the whole entry is what
 * makes a change recoverable; `content` lives on a snapshot instead. `seq`
 * is dense per record and never the change feed's `cursor`. See
 * docs/spec/wire-format.md § Journal.
 */
export type WireJournalEntry = {
  seq: number;
  at: string;
  kind: ChangeKind;
  ops: ChangeOp[];
  version: number;
  typeId: string;
  parentId?: string;
  actor?: WireChangeActor;
  /**
   * The container the move took the record out of — and the one field on
   * any response where `null` is a value rather than an input spelling.
   * Absent means this entry is not a reparent; present and `null` means it
   * moved out of the root. Collapsing the two would lose which one
   * happened, so the root sentinel travels here as it does on a request.
   */
  previousParentId?: string | null;
  /**
   * One tagged edit per association the write moved, each carrying its own
   * `previous` where it had one. Has no counterpart on the change feed,
   * which reports what is true now across two flat lists.
   */
  associations?: AssociationChange[];
};

/**
 * The response envelope of `GET /records/:id/journal`. `cursor` is the only
 * end-of-log signal, since a server may cap a page below the `limit` asked
 * for. It carries the `seq` to send as the next `afterSeq`, and is null
 * once nothing follows.
 */
export type WireJournalResponse = {
  entries: WireJournalEntry[];
  cursor: number | null;
};

export function serializeJournalEntry(e: RecordJournalEntry): WireJournalEntry {
  const w: WireJournalEntry = {
    seq: e.seq,
    at: e.at.toISOString(),
    kind: e.kind,
    // Copied for the same reason serializeChange() copies: the array
    // belongs to the entry the adapter read, not to this response.
    ops: [...e.ops],
    version: e.version,
    typeId: e.typeId,
  };
  if (e.parentId !== undefined) w.parentId = e.parentId;
  if (e.actor !== undefined) w.actor = serializeChangeActor(e.actor);
  // Presence, not truthiness: `null` is the root and has to survive.
  if (e.previousParentId !== undefined) w.previousParentId = e.previousParentId;
  if (e.associations !== undefined) w.associations = e.associations;
  return w;
}
