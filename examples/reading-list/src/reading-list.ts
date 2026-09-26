/**
 * ReadingList — a small personal book tracker built on @haverstack/core
 * -------------------------------------------------------
 * The app layer a real consumer would write: it owns its types, wraps the
 * generic record API in domain verbs, and never touches an adapter
 * directly. It exists to exercise the Stack API the way an app author
 * meets it, so the places where it has to work around the library are
 * left visible and cross-referenced to FINDINGS.md rather than hidden.
 *
 * Setup (defineType, registerMigration, migrateAll, grants) needs the full
 * `Stack`; everything else runs against `StackClient`, so the same class
 * serves the owner and a friend reading through `stack.asEntity()`.
 */

import type {
  EntityId,
  RecordChange,
  RecordId,
  RecordJournalEntry,
  RecordVersion,
  Stack,
  StackClient,
  StackQuery,
  StackRecord,
  Unsubscribe,
} from '@haverstack/core';
import { StackVersionConflictError } from '@haverstack/core';
import {
  BOOK,
  BOOK_BASE,
  BOOK_V1,
  REVIEW,
  SHELF,
  bookType,
  bookV1Type,
  reviewType,
  shelfType,
} from './schema.ts';
import type { BookContent, BookStatus, ReviewContent, ShelfContent } from './schema.ts';

export const APP_ID = 'com.example.reading';

export type Book = StackRecord & { content: BookContent };
export type Shelf = StackRecord & { content: ShelfContent };
export type Review = StackRecord & { content: ReviewContent };

export type BookFilter = {
  status?: BookStatus;
  tag?: string;
  shelf?: RecordId;
  search?: string;
  sortBy?: 'title' | 'added';
  pageSize?: number;
};

/** Every record read is untyped, so each read site narrows by hand. */
const asBook = (r: StackRecord): Book => r as Book;

/**
 * Registers the app's types and brings every stored book up to the
 * current schema. Owner-only: a ScopedStack cannot define types.
 */
export async function installReadingList(stack: Stack): Promise<void> {
  await stack.defineType(shelfType);
  await stack.defineType(bookV1Type);
  await stack.defineType(bookType);
  await stack.defineType(reviewType);
  stack.registerMigration({
    from: BOOK_V1,
    to: BOOK,
    // @1 stored 'done' for a finished book; @2 speaks 'finished'.
    migrate: (c) => ({ ...c, status: c.status === 'done' ? 'finished' : c.status }),
  });
  // migrateAll takes a baseId; passing BOOK (a TypeId) throws.
  await stack.migrateAll(BOOK_BASE);
}

export class ReadingList {
  private readonly client: StackClient;

  constructor(client: StackClient) {
    this.client = client;
  }

  // -------------------------------------------------------
  // Shelves and books
  // -------------------------------------------------------

  async addShelf(name: string): Promise<Shelf> {
    return this.client.create<ShelfContent>(SHELF, { name }, { appId: APP_ID });
  }

  async shelves(): Promise<Shelf[]> {
    const { records } = await this.client.query({
      filter: { typeId: SHELF },
      sort: { contentField: 'name' },
    });
    return records as Shelf[];
  }

  async addBook(
    content: Omit<BookContent, 'status'> & { status?: BookStatus },
    opts: { shelf?: RecordId; tags?: string[] } = {},
  ): Promise<Book> {
    return this.client.create<BookContent>(
      BOOK,
      { status: 'want', ...content },
      {
        appId: APP_ID,
        parentId: opts.shelf,
        associations: opts.tags?.map((label) => ({ kind: 'tag', label })),
      },
    );
  }

  async getBook(id: RecordId): Promise<Book | null> {
    // presentAt: 'latest' so a caller never sees @1-shaped content, even
    // before migrateAll() has swept this record.
    const record = await this.client.get(id, { presentAt: 'latest' });
    if (!record || record.deletedAt || !record.typeId.startsWith(`${BOOK_BASE}@`)) return null;
    return asBook(record);
  }

  async startReading(id: RecordId): Promise<Book> {
    return asBook(await this.client.patchContent(id, { status: 'reading' }));
  }

  /**
   * Marks a book finished only if nobody else changed it since `seen` was
   * read — the optimistic-concurrency path. Returns null on a lost race so
   * the caller can re-read and decide.
   */
  async finish(seen: Book, opts: { rating?: number; on?: Date } = {}): Promise<Book | null> {
    const on = (opts.on ?? new Date()).toISOString().slice(0, 10);
    try {
      const updated = await this.client.patchContent(
        seen.id,
        { status: 'finished', finishedOn: on, rating: opts.rating ?? null },
        { ifVersion: seen.version },
      );
      return asBook(updated);
    } catch (err) {
      if (err instanceof StackVersionConflictError) return null;
      throw err;
    }
  }

  async moveToShelf(id: RecordId, shelf: RecordId | null): Promise<Book> {
    return asBook(await this.client.mutate(id, { parentId: shelf }));
  }

  async tag(id: RecordId, label: string): Promise<Book> {
    return asBook(await this.client.associate(id, { kind: 'tag', label }));
  }

  async untag(id: RecordId, label: string): Promise<Book> {
    return asBook(await this.client.dissociate(id, { kind: 'tag', label }));
  }

  async linkIsbn(id: RecordId, isbn: string): Promise<Book> {
    return asBook(
      await this.client.associate(id, {
        kind: 'relationship',
        label: 'same-as',
        target: { kind: 'external', ns: 'isbn', id: isbn },
      }),
    );
  }

  async findByIsbn(isbn: string): Promise<Book | null> {
    const { records } = await this.client.query({
      filter: {
        baseId: BOOK_BASE,
        relatedTo: { label: 'same-as', target: { kind: 'external', ns: 'isbn', id: isbn } },
      },
      limit: 1,
      presentAt: 'latest',
    });
    return records[0] ? asBook(records[0]) : null;
  }

  /** Every matching book, following cursors until the last page. */
  async *books(filter: BookFilter = {}): AsyncGenerator<Book> {
    const query: StackQuery = {
      filter: {
        baseId: BOOK_BASE,
        ...(filter.status && { content: { status: filter.status } }),
        ...(filter.tag && { tags: [filter.tag] }),
        ...(filter.shelf && { parentId: filter.shelf }),
        ...(filter.search && { search: filter.search }),
      },
      sort:
        filter.sortBy === 'title'
          ? { contentField: 'title', direction: 'asc' }
          : { field: 'createdAt', direction: 'asc' },
      limit: filter.pageSize ?? 50,
      presentAt: 'latest',
    };
    let cursor: string | null | undefined;
    do {
      const page = await this.client.query({ ...query, cursor: cursor ?? undefined });
      for (const r of page.records) yield asBook(r);
      cursor = page.cursor;
    } while (cursor);
  }

  async listBooks(filter: BookFilter = {}): Promise<Book[]> {
    const out: Book[] = [];
    for await (const b of this.books(filter)) out.push(b);
    return out;
  }

  // -------------------------------------------------------
  // Reviews (relationships between records)
  // -------------------------------------------------------

  async review(bookId: RecordId, text: string): Promise<Review> {
    return this.client.create<ReviewContent>(
      REVIEW,
      { text },
      {
        appId: APP_ID,
        associations: [
          { kind: 'relationship', label: 'reviews', target: { kind: 'record', recordId: bookId } },
        ],
      },
    );
  }

  async reviewsOf(bookId: RecordId): Promise<Review[]> {
    const { records } = await this.client.query({
      filter: {
        typeId: REVIEW,
        relatedTo: { label: 'reviews', target: { kind: 'record', recordId: bookId } },
      },
    });
    return records as Review[];
  }

  // -------------------------------------------------------
  // Covers (attachments)
  // -------------------------------------------------------

  async setCover(bookId: RecordId, bytes: Uint8Array, mimeType: string): Promise<Book> {
    const upload = await this.client.putAttachment(bytes, { mimeType, appId: APP_ID });
    const book = await this.client.get(bookId);
    const previous = book?.associations?.find(
      (a) => a.kind === 'attachment' && a.label === 'cover',
    );
    // Two writes, not one: associate() adds, and the only replace is
    // mutate({ associations }), which rewrites every tag too.
    if (previous) await this.client.dissociate(bookId, previous);
    return asBook(
      await this.client.associate(bookId, {
        kind: 'attachment',
        label: 'cover',
        fileId: upload.content.fileId,
        attachmentRecordId: upload.id,
      }),
    );
  }

  async getCover(bookId: RecordId): Promise<Uint8Array | null> {
    const book = await this.client.get(bookId);
    const cover = book?.associations?.find((a) => a.kind === 'attachment' && a.label === 'cover');
    if (!cover || cover.kind !== 'attachment') return null;
    return this.client.getAttachment(cover.fileId);
  }

  // -------------------------------------------------------
  // History, lifecycle, change feed
  // -------------------------------------------------------

  async history(
    id: RecordId,
  ): Promise<{ versions: RecordVersion[]; journal: RecordJournalEntry[] }> {
    const [versions, journal] = await Promise.all([
      this.client.getVersions(id),
      this.client.getJournal(id),
    ]);
    // Adapters disagree on getVersions() order (MemoryAdapter oldest-first,
    // SQLite newest-first), so pin it here. See FINDINGS.md.
    versions.sort((a, b) => a.version - b.version);
    return { versions, journal };
  }

  async revert(id: RecordId, version: number): Promise<Book> {
    return asBook(await this.client.restoreVersion(id, version));
  }

  async remove(id: RecordId): Promise<void> {
    await this.client.delete(id);
  }

  async restore(id: RecordId): Promise<Book> {
    return asBook(await this.client.undelete(id));
  }

  async onBookChange(handler: (change: RecordChange) => void): Promise<Unsubscribe> {
    return this.client.subscribe(handler, { filter: { baseId: BOOK_BASE } });
  }
}

// -------------------------------------------------------
// Sharing (owner-only, so it takes the full Stack)
// -------------------------------------------------------

/** Lets `friend` read every book and review, and nothing else. */
export async function shareLibraryWith(stack: Stack, friend: EntityId): Promise<void> {
  const grantee = { kind: 'entity', entityId: friend } as const;
  await stack.grantType(BOOK_BASE, { actions: ['read-any'], grantee });
  await stack.grantType(REVIEW, { actions: ['read-any'], grantee });
}

/**
 * Lets `friend` edit one book. Record-level `write` is refused unless the
 * same grantee already holds `read`, so this is two ordered calls.
 */
export async function letEdit(stack: Stack, bookId: RecordId, friend: EntityId): Promise<void> {
  const grantee = { kind: 'entity', entityId: friend } as const;
  await stack.grantAccess(bookId, { kind: 'permission', label: 'read', grantee });
  await stack.grantAccess(bookId, { kind: 'permission', label: 'write', grantee });
}
