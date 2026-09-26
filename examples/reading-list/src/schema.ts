/**
 * The reading list's record types. Content interfaces are declared by hand
 * beside each schema because the library has no way to derive one from the
 * other — see FINDINGS.md, item 5.
 */

import type { DefineTypeOptions } from '@haverstack/core';

export const NS = 'com.example.reading';

export const SHELF = `${NS}/shelf@1`;
export const BOOK_BASE = `${NS}/book`;
export const BOOK_V1 = `${BOOK_BASE}@1`;
export const BOOK = `${BOOK_BASE}@2`;
export const REVIEW = `${NS}/review@1`;

export type BookStatus = 'want' | 'reading' | 'finished' | 'abandoned';

export type ShelfContent = { name: string };

export type BookContent = {
  title: string;
  author: string;
  status: BookStatus;
  pages?: number;
  /** ISO 8601 — `date` fields take strings, not Date objects. */
  finishedOn?: string;
  /** 1–5, added in @2. */
  rating?: number;
};

export type ReviewContent = { text: string };

export const shelfType: DefineTypeOptions = {
  id: SHELF,
  name: 'Shelf',
  schema: { name: { kind: 'string', required: true } },
};

const bookV1Schema = {
  title: { kind: 'string', required: true },
  author: { kind: 'string', required: true },
  status: { kind: 'string', required: true },
  pages: { kind: 'number' },
  finishedOn: { kind: 'date' },
} as const;

export const bookV1Type: DefineTypeOptions = { id: BOOK_V1, name: 'Book', schema: bookV1Schema };

export const bookType: DefineTypeOptions = {
  id: BOOK,
  name: 'Book',
  migratesFrom: BOOK_V1,
  schema: { ...bookV1Schema, rating: { kind: 'number' } },
};

export const reviewType: DefineTypeOptions = {
  id: REVIEW,
  name: 'Review',
  schema: { text: { kind: 'text', required: true } },
};
