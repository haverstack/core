/**
 * Matching a ReadReach in memory
 * -------------------------------------------------------
 * The predicate a JavaScript adapter applies for queryReadable(), stated
 * once so every in-process adapter reads a reach the same way. A SQL
 * adapter states the same conditions in its own query language.
 * See docs/spec/adapters.md § Querying within a reach.
 */

import { associationEqual } from '../associations/identity.js';
import type { ReadReach, StackRecord } from '../types/index.js';

/** Whether `record` is inside the reach: within the fence, and met by one of its arms. */
export function inReach(record: StackRecord, reach: ReadReach): boolean {
  if (reach.fence && !reach.fence.includes(record.typeId)) return false;
  if (reach.typeIds.includes(record.typeId)) return true;
  const authored = reach.authored;
  if (
    authored &&
    authored.typeIds.includes(record.typeId) &&
    record.createdBy?.subjectId === authored.subjectId
  ) {
    return true;
  }
  return reach.permissions.some((p) =>
    (record.permissions ?? []).some((held) => associationEqual(p, held)),
  );
}
