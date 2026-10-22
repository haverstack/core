/**
 * Content predicates, evaluated in memory
 * -------------------------------------------------------
 * How a `content` filter value and a `contentPresent` path are matched
 * against one content object: element-wise through arrays, with `null`
 * standing for "no value". MemoryAdapter answers queries with it, and a
 * collection decides a constant a migration added the same way, so a key
 * dropped in core matches exactly what an adapter would have matched. See
 * docs/spec/data-model.md § Nested content paths.
 */

import { parseContentFilterKey } from './query-validation.js';
import type { ContentArm } from './types/index.js';

/** An array stands for its elements; anything else stands for itself. */
const spreadValue = (value: unknown): unknown[] => (Array.isArray(value) ? value : [value]);

/**
 * Every value reachable by walking `segments`, spreading arrays at each
 * step — the walk sqlite-shared runs in SQL, so a filter answers the same
 * against either. Empty means the path reaches nothing, which a `null`
 * filter value matches.
 */
export const valuesAtContentPath = (
  content: Record<string, unknown>,
  segments: string[],
): unknown[] => {
  let current: unknown[] = [content];
  for (const segment of segments) {
    const next: unknown[] = [];
    for (const value of current) {
      for (const item of spreadValue(value)) {
        if (typeof item !== 'object' || item === null || Array.isArray(item)) continue;
        if (Object.hasOwn(item, segment)) next.push((item as Record<string, unknown>)[segment]);
      }
    }
    current = next;
  }
  // The leaf spreads too, so a filter on `tags` matches a record whose
  // `tags` array contains the value.
  return current.flatMap(spreadValue);
};

/**
 * Whether `content` satisfies a `content` and `contentPresent` predicate. A
 * `null` filter value means "field absent or null", not "match nothing":
 * plain `===` would miss an absent field (docs/spec/data-model.md § Filter).
 */
export const matchesContent = (content: Record<string, unknown>, predicate: ContentArm): boolean =>
  Object.entries(predicate.content ?? {}).every(([key, value]) => {
    const found = valuesAtContentPath(content, parseContentFilterKey(key));
    if (value === null || value === undefined) {
      return found.length === 0 || found.some((v) => v === null || v === undefined);
    }
    return found.some((v) => v === value);
  }) &&
  (predicate.contentPresent ?? []).every((key) =>
    valuesAtContentPath(content, parseContentFilterKey(key)).some(
      (v) => v !== null && v !== undefined,
    ),
  );
