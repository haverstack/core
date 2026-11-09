/**
 * Matching a Reach in memory
 * -------------------------------------------------------
 * The one reading of a reach in JavaScript: MemoryAdapter matches a query
 * with it, and ScopedStack asks it of each Record a verb would act on. A
 * SQL adapter states the same conditions in its own query language. See
 * docs/spec/access-control.md § Reach.
 */

import { associationKey } from '../associations/identity.js';
import { baseIdOf } from '../schema.js';
import type { Reach, StackRecord } from '../types/index.js';

/** What a reach asks of a Record — all a record yet to be created has to show. */
export type ReachedRecord = Pick<StackRecord, 'typeId' | 'createdBy' | 'permissions'>;

/** Whether `record` is inside the reach, matched by its family. */
export function inReach(record: ReachedRecord, reach: Reach): boolean {
  const family = baseIdOf(record.typeId);
  if (reach.fence && !reach.fence.includes(family)) return false;
  const within = reach.within;
  if (!within) return true;
  if (within.baseIds.includes(family)) return true;
  const authored = within.authored;
  if (
    authored &&
    authored.baseIds.includes(family) &&
    record.createdBy?.subjectId === authored.subjectId
  ) {
    return true;
  }
  const held = new Set((record.permissions ?? []).map(associationKey));
  held.delete(undefined);
  return within.permissions.some(
    (set) => set.length > 0 && set.every((element) => held.has(associationKey(element))),
  );
}
