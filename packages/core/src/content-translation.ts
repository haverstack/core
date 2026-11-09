/**
 * Content queries across versions
 * -------------------------------------------------------
 * A collection's content filter and sort are written in its handle's
 * shape, and an adapter matches content as stored. These functions rewrite
 * one predicate or sort field into an older version's shape, through the
 * field origins a migration chain declares, or say why they cannot: an arm
 * no record at that version can match is dropped, and one that does not
 * translate is narrowed. See docs/spec/data-model.md § Content queries
 * across versions.
 */

import { matchesContent } from './content-match.js';
import { sortConstant } from './adapter/sort.js';
import { parseContentFilterKey } from './query-validation.js';
import type { FieldOrigin, FieldOrigins } from './migration-steps.js';
import type { ContentArm, ContentSortKey, ScalarFieldKind } from './types/index.js';

/** No record at the version can match, so its arm is dropped without a skip. */
export const UNMATCHABLE = 'unmatchable';
/** The version is narrowed: left out of the query, and reported if it matches the rest. */
export const UNTRANSLATABLE = 'untranslatable';

type Untranslated = typeof UNMATCHABLE | typeof UNTRANSLATABLE;

/**
 * The older values a `map` sends to `value`, mapped ones first. A value no
 * entry names maps to itself, and `map` reaches strings only.
 */
const sourcesOf = (values: Readonly<Record<string, string>>, value: unknown): unknown[] => {
  if (typeof value !== 'string') return [value];
  const sources: unknown[] = Object.keys(values).filter((from) => values[from] === value);
  if (!Object.hasOwn(values, value)) sources.push(value);
  return sources;
};

/**
 * Whether a constant satisfies one key, decided as an adapter would decide
 * it against a record holding the constant at `field`.
 */
const constantMatches = (
  field: string,
  origin: Extract<FieldOrigin, { kind: 'constant' }>,
  predicate: ContentArm,
): boolean =>
  matchesContent(origin.value === undefined ? {} : { [field]: origin.value }, predicate);

/**
 * An older version's arm, and the arms it leaves out: when two older
 * values map to the one a key asks for, the arm asks for the first and
 * each other one becomes a residual, which the first page probes for
 * `skipped.older` rather than narrowing the version outright.
 */
export type TranslatedArm = { arm: ContentArm; residuals: ContentArm[] };

/**
 * `predicate`, written in the handle's shape, as the arm for the version
 * `origins` describes. A key is translated by its top-level field: the
 * rest of its path is kept, since steps reach top-level fields only.
 */
export const translateArm = (
  origins: FieldOrigins,
  predicate: ContentArm,
): TranslatedArm | Untranslated => {
  const content: Record<string, unknown> = {};
  const present: string[] = [];
  let split: { path: string; others: unknown[] } | undefined;
  const keys: [string, unknown, boolean][] = [
    ...Object.entries(predicate.content ?? {}).map(
      ([key, value]) => [key, value, false] as [string, unknown, boolean],
    ),
    ...(predicate.contentPresent ?? []).map(
      (key) => [key, undefined, true] as [string, unknown, boolean],
    ),
  ];
  for (const [key, value, presence] of keys) {
    const [field, ...rest] = parseContentFilterKey(key);
    const origin = origins.get(field);
    if (!origin || origin.kind === 'derived') return UNTRANSLATABLE;
    if (origin.kind === 'constant') {
      const asked = presence ? { contentPresent: [key] } : { content: { [key]: value } };
      if (!constantMatches(field, origin, asked)) return UNMATCHABLE;
      continue;
    }
    const path = [origin.field, ...rest].join('.');
    if (presence) {
      present.push(path);
      continue;
    }
    // A path below a mapped field reaches no string, so only the field's
    // own values are remapped; `null` is never one of them.
    if (!origin.values || rest.length > 0 || value === null || value === undefined) {
      content[path] = value;
      continue;
    }
    const [first, ...others] = sourcesOf(origin.values, value);
    if (first === undefined) return UNMATCHABLE;
    // One split per arm keeps the probes to one per source; two would
    // multiply them.
    if (others.length > 0) {
      if (split) return UNTRANSLATABLE;
      split = { path, others };
    }
    content[path] = first;
  }
  const arm = {
    ...(Object.keys(content).length > 0 && { content }),
    ...(present.length > 0 && { contentPresent: present }),
  };
  const residuals = (split?.others ?? []).map((other) => ({
    ...arm,
    content: { ...content, [split!.path]: other },
  }));
  return { arm, residuals };
};

/**
 * What a record at the version `origins` describes orders by, for a sort
 * on the handle's `field` of `kind`. A remapped field is narrowed, since
 * remapped values don't keep their order.
 */
export const translateSortKey = (
  origins: FieldOrigins,
  field: string,
  kind: ScalarFieldKind | undefined,
): ContentSortKey | typeof UNTRANSLATABLE => {
  const origin = origins.get(field);
  if (!origin || !kind || origin.kind === 'derived') return UNTRANSLATABLE;
  if (origin.kind === 'constant') return { value: sortConstant(kind, origin.value) };
  if (origin.values && Object.keys(origin.values).length > 0) return UNTRANSLATABLE;
  return { field: origin.field };
};
