/**
 * @haverstack/commons
 * -------------------------------------------------------
 * Canonical Schema Commons type definitions — see docs/commons/README.md for
 * the design rules and governance process these schemas are bound by.
 *
 * Each export mirrors the fenced `stack.defineType(...)` block in its type's
 * doc file exactly. Apps register commons types by passing these constants
 * to `defineCommonsTypes()` rather than hand-copying schemas out of
 * markdown, which is the drift the Schema Commons' governance process exists
 * to prevent.
 *
 * Each constant is also a type handle, so `stack.create(NOTE, …)` and the
 * other typed overloads derive content types from the same literal. See
 * docs/spec/data-model.md § Type handles.
 *
 * Only Draft-status types are exported here. Proposed types (not yet backed
 * by a concrete intended writer) stay docs-only until they graduate.
 */

import { typeHandle } from '@haverstack/core';
import type { ReadonlyTypeSchema, Stack, StackType, TypeHandle, TypeId } from '@haverstack/core';

/** A type handle plus the display name `defineType()` takes. */
export type CommonsType<S extends ReadonlyTypeSchema = ReadonlyTypeSchema> = TypeHandle<S> & {
  readonly name: string;
};

const commonsType = <const S extends ReadonlyTypeSchema>(
  id: TypeId,
  name: string,
  schema: S,
): CommonsType<S> => Object.freeze({ ...typeHandle(id, schema), name });

const labeledValue = {
  kind: 'object',
  properties: {
    value: { kind: 'string', required: true },
    label: { kind: 'string' },
  },
} as const;

export const NOTE = commonsType('org.haverstack/note@1', 'Note', {
  text: { kind: 'text', required: true },
  title: { kind: 'string' },
  format: { kind: 'string' },
});

export const BOOKMARK = commonsType('org.haverstack/bookmark@1', 'Bookmark', {
  url: { kind: 'string', required: true },
  title: { kind: 'string' },
  description: { kind: 'text' },
});

export const TASK = commonsType('org.haverstack/task@1', 'Task', {
  title: { kind: 'string', required: true },
  done: { kind: 'boolean', required: true },
  notes: { kind: 'text' },
  due: { kind: 'date' },
  completedAt: { kind: 'date' },
});

export const CONTACT = commonsType('org.haverstack/contact@1', 'Contact', {
  name: { kind: 'string', required: true },
  emails: { kind: 'array', items: labeledValue },
  phones: { kind: 'array', items: labeledValue },
  urls: { kind: 'array', items: labeledValue },
  org: { kind: 'string' },
  note: { kind: 'text' },
});

export const ARTICLE = commonsType('org.haverstack/article@1', 'Article', {
  title: { kind: 'string', required: true },
  text: { kind: 'text', required: true },
  format: { kind: 'string' },
  summary: { kind: 'text' },
  url: { kind: 'string' },
  author: { kind: 'string' },
  publishedAt: { kind: 'date' },
});

export const PLACE = commonsType('org.haverstack/place@1', 'Place', {
  latitude: { kind: 'number', required: true },
  longitude: { kind: 'number', required: true },
  name: { kind: 'string' },
  address: { kind: 'string' },
  url: { kind: 'string' },
});

export const PAGE = commonsType('org.haverstack/page@1', 'Page', {
  slug: { kind: 'string', required: true },
  text: { kind: 'text', required: true },
  title: { kind: 'string' },
  format: { kind: 'string' },
  publishedAt: { kind: 'date' },
  collection: {
    kind: 'object',
    properties: {
      typeId: { kind: 'string', required: true },
      tag: { kind: 'string' },
      order: { kind: 'string' },
    },
  },
});

export const IMAGE = commonsType('org.haverstack/image@1', 'Image', {
  file: { kind: 'file-ref', required: true },
  caption: { kind: 'text' },
  alt: { kind: 'string' },
  capturedAt: { kind: 'date' },
});

export const POST = commonsType('org.haverstack/post@1', 'Post', {
  text: { kind: 'text', required: true },
  format: { kind: 'string' },
  url: { kind: 'string' },
});

export const SITE = commonsType('org.haverstack/site@1', 'Site', {
  title: { kind: 'string', required: true },
  baseUrl: { kind: 'string', required: true },
  description: { kind: 'text' },
  handle: { kind: 'string' },
});

/**
 * Registers each given commons type on `stack` via `defineType()`, exactly
 * as written here. Sequential, matching `Stack`'s own system-type seeding —
 * each call is independent, but running in order keeps the returned array
 * predictable.
 */
export const defineCommonsTypes = async (
  stack: Stack,
  types: readonly CommonsType[],
): Promise<StackType[]> => {
  const defined: StackType[] = [];
  for (const type of types) {
    defined.push(await stack.defineType(type));
  }
  return defined;
};
