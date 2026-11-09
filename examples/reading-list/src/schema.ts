/**
 * The reading list's record types, each written once as a type handle that
 * carries its id, display name, schema and lineage. Content types are
 * derived from the schemas, and named with interfaces so editors show them
 * by name.
 */

import { derive, migration, typeHandle } from '@haverstack/core';
import type { ContentOf } from '@haverstack/core';

export const Shelf = typeHandle({
  id: 'com.example.reading/shelf@1',
  name: 'Shelf',
  schema: { name: { kind: 'string', required: true } },
});

const bookFields = {
  title: { kind: 'string', required: true },
  author: { kind: 'string', required: true },
  pages: { kind: 'number' },
  finishedOn: { kind: 'date' },
} as const;

/** The first release stored `status` as free text, and wrote 'done' for finished. */
export const BookV1 = typeHandle({
  id: 'com.example.reading/book@1',
  name: 'Book',
  schema: { ...bookFields, status: { kind: 'string', required: true } },
});

export const Book = typeHandle({
  id: 'com.example.reading/book@2',
  name: 'Book',
  migratesFrom: BookV1,
  schema: {
    ...bookFields,
    status: {
      kind: 'enum',
      values: ['want', 'reading', 'finished', 'abandoned'],
      required: true,
    },
    rating: { kind: 'number' },
  },
});

export const Review = typeHandle({
  id: 'com.example.reading/review@1',
  name: 'Review',
  schema: { text: { kind: 'text', required: true } },
});

/**
 * Passed to every Stack.open(), so the chain is complete before the first
 * read. `map()` only carries enum to enum, so free text becomes an enum
 * through `derive()`, which the schema check can't see into.
 */
export const migrations = [
  migration(BookV1, Book, [derive('status', (c) => (c.status === 'done' ? 'finished' : c.status))]),
];

/* eslint-disable @typescript-eslint/no-empty-object-type -- the interface name is the point */
export interface ShelfContent extends ContentOf<typeof Shelf.schema> {}
export interface BookContent extends ContentOf<typeof Book.schema> {}
export interface ReviewContent extends ContentOf<typeof Review.schema> {}
/* eslint-enable @typescript-eslint/no-empty-object-type */

export type BookStatus = BookContent['status'];
