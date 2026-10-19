/**
 * Matching a Reach in memory
 * -------------------------------------------------------
 * The one reading of a reach in JavaScript: MemoryAdapter matches a query
 * with it, and ScopedStack asks it of each Record a verb would act on, over
 * families rather than TypeIds. A SQL adapter states the same conditions in
 * its own query language. See docs/spec/access-control.md § Reach.
 */

import { associationEqual } from '../associations/identity.js';
import type { Reach, StackRecord } from '../types/index.js';

/** What a reach asks of a Record — all a record yet to be created has to show. */
export type ReachedRecord = Pick<StackRecord, 'typeId' | 'createdBy' | 'permissions'>;

/**
 * Whether `record` is inside the reach. `typeOf` names the Type the reach
 * lists a Record under — its TypeId unless the reach is over families.
 */
export function inReach<Type extends string>(
  record: ReachedRecord,
  reach: Reach<Type>,
  typeOf: (record: ReachedRecord) => string = (r) => r.typeId,
): boolean {
  const type = typeOf(record) as Type;
  if (reach.fence && !reach.fence.includes(type)) return false;
  const within = reach.within;
  if (!within) return true;
  if (within.types.includes(type)) return true;
  const authored = within.authored;
  if (
    authored &&
    authored.types.includes(type) &&
    record.createdBy?.subjectId === authored.subjectId
  ) {
    return true;
  }
  const held = record.permissions ?? [];
  return within.permissions.some((set) =>
    set.every((element) => held.some((h) => associationEqual(element, h))),
  );
}
