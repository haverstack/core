/**
 * The reading list's record types, each written once as a type handle. The
 * content types are derived from the schemas, so there is nothing to keep
 * in step by hand.
 */

import { typeHandle } from '@haverstack/core';
import type { ContentOf } from '@haverstack/core';

export const Shelf = typeHandle('com.example.reading/shelf@1', {
  name: { kind: 'string', required: true },
});

const bookV1Fields = {
  title: { kind: 'string', required: true },
  author: { kind: 'string', required: true },
  pages: { kind: 'number' },
  finishedOn: { kind: 'date' },
} as const;

/** The first release stored `status` as free text, and wrote 'done' for finished. */
export const BookV1 = typeHandle('com.example.reading/book@1', {
  ...bookV1Fields,
  status: { kind: 'string', required: true },
});

export const Book = typeHandle('com.example.reading/book@2', {
  ...bookV1Fields,
  status: { kind: 'string', enum: ['want', 'reading', 'finished', 'abandoned'], required: true },
  rating: { kind: 'number' },
});

export const Review = typeHandle('com.example.reading/review@1', {
  text: { kind: 'text', required: true },
});

/** An interface rather than a type alias, so editors show it by name. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- the name is the point
export interface BookContent extends ContentOf<typeof Book.schema> {}
export type BookStatus = BookContent['status'];
