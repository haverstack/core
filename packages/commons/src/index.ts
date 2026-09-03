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
 * Only Draft-status types are exported here. Proposed types (not yet backed
 * by a concrete intended writer) stay docs-only until they graduate.
 */

import type { Stack, StackType, TypeId, TypeSchema } from '@haverstack/core';

export type CommonsType = {
  readonly id: TypeId;
  readonly name: string;
  readonly schema: TypeSchema;
};

const labeledValue = {
  kind: 'object',
  properties: {
    value: { kind: 'string', required: true },
    label: { kind: 'string' },
  },
} as const;

export const NOTE: CommonsType = {
  id: 'org.haverstack/note@1',
  name: 'Note',
  schema: {
    text: { kind: 'text', required: true },
    title: { kind: 'string' },
    format: { kind: 'string' },
  },
};

export const BOOKMARK: CommonsType = {
  id: 'org.haverstack/bookmark@1',
  name: 'Bookmark',
  schema: {
    url: { kind: 'string', required: true },
    title: { kind: 'string' },
    description: { kind: 'text' },
  },
};

export const TASK: CommonsType = {
  id: 'org.haverstack/task@1',
  name: 'Task',
  schema: {
    title: { kind: 'string', required: true },
    done: { kind: 'boolean', required: true },
    notes: { kind: 'text' },
    due: { kind: 'date' },
    completedAt: { kind: 'date' },
  },
};

export const CONTACT: CommonsType = {
  id: 'org.haverstack/contact@1',
  name: 'Contact',
  schema: {
    name: { kind: 'string', required: true },
    emails: { kind: 'array', items: labeledValue },
    phones: { kind: 'array', items: labeledValue },
    urls: { kind: 'array', items: labeledValue },
    org: { kind: 'string' },
    note: { kind: 'text' },
  },
};

export const ARTICLE: CommonsType = {
  id: 'org.haverstack/article@1',
  name: 'Article',
  schema: {
    title: { kind: 'string', required: true },
    text: { kind: 'text', required: true },
    format: { kind: 'string' },
    summary: { kind: 'text' },
    url: { kind: 'string' },
    author: { kind: 'string' },
    publishedAt: { kind: 'date' },
  },
};

export const PLACE: CommonsType = {
  id: 'org.haverstack/place@1',
  name: 'Place',
  schema: {
    latitude: { kind: 'number', required: true },
    longitude: { kind: 'number', required: true },
    name: { kind: 'string' },
    address: { kind: 'string' },
    url: { kind: 'string' },
  },
};

export const PAGE: CommonsType = {
  id: 'org.haverstack/page@1',
  name: 'Page',
  schema: {
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
  },
};

export const PHOTO: CommonsType = {
  id: 'org.haverstack/photo@1',
  name: 'Photo',
  schema: {
    image: { kind: 'file-ref', required: true },
    caption: { kind: 'text' },
    alt: { kind: 'string' },
    takenAt: { kind: 'date' },
  },
};

export const POST: CommonsType = {
  id: 'org.haverstack/post@1',
  name: 'Post',
  schema: {
    text: { kind: 'text', required: true },
    format: { kind: 'string' },
    url: { kind: 'string' },
  },
};

export const SITE: CommonsType = {
  id: 'org.haverstack/site@1',
  name: 'Site',
  schema: {
    title: { kind: 'string', required: true },
    baseUrl: { kind: 'string', required: true },
    description: { kind: 'text' },
    handle: { kind: 'string' },
  },
};

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
    defined.push(await stack.defineType(type.id, type.name, type.schema));
  }
  return defined;
};
