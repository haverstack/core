/**
 * Matching a ReadReach in memory
 * -------------------------------------------------------
 * The one reading of a reach in JavaScript: MemoryAdapter matches a query
 * with it, and ScopedStack answers whether one Record is readable with it,
 * over families rather than TypeIds. A SQL adapter states the same
 * conditions in its own query language.
 * See docs/spec/adapters.md § Querying within a reach.
 */

import { associationEqual } from '../associations/identity.js';
import type { ReadReach, StackRecord } from '../types/index.js';

/**
 * Whether `record` is inside the reach. `typeOf` names the Type the reach
 * lists a Record under — its TypeId unless the reach is over families.
 */
export function inReach<Type extends string>(
  record: StackRecord,
  reach: ReadReach<Type>,
  typeOf: (record: StackRecord) => string = (r) => r.typeId,
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
  return within.permissions.some((p) =>
    (record.permissions ?? []).some((held) => associationEqual(p, held)),
  );
}
