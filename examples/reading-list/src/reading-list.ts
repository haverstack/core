/**
 * ReadingList — a small personal book tracker built on @haverstack/core
 * -------------------------------------------------------
 * The app layer a real consumer would write: it owns its types, wraps the
 * generic record API in domain verbs, and never touches an adapter
 * directly. It exists to exercise the Stack API the way an app author
 * meets it, so the places where it still has to work around the library
 * are left visible and cross-referenced to FINDINGS-3.md.
 *
 * Layered as the root README's "Writing an app" lays out: migrations passed
 * to every `Stack.open()`, an install the owner runs, and a data layer of
 * collections over `StackClient`, so the same class serves the owner and a
 * friend reading through `stack.asEntity()`.
 */

import { StackVersionConflictError } from '@haverstack/core';
import type {
  AppManifest,
  Collection,
  CollectionChange,
  CollectionQuery,
  CollectionRecord,
  EntityId,
  InstallRequest,
  Misfit,
  RecordId,
  RecordJournalEntry,
  RecordVersion,
  Stack,
  StackClient,
  Unsubscribe,
} from '@haverstack/core';
import { Book, BookV1, Review, Shelf } from './schema.ts';
import type { BookContent, BookStatus, ReviewContent, ShelfContent } from './schema.ts';

export const APP_ID = 'com.example.reading';

export type BookRecord = CollectionRecord<BookContent>;
export type ShelfRecord = CollectionRecord<ShelfContent>;
export type ReviewRecord = CollectionRecord<ReviewContent>;

export type BookFilter = {
  status?: BookStatus;
  tag?: string;
  shelf?: RecordId;
  search?: string;
  sortBy?: 'title' | 'added';
  pageSize?: number;
};

export type BookList = {
  books: BookRecord[];
  misfits: Misfit[];
  skipped: { older: boolean; newer: boolean };
};

/** Owner-only, once per stack and again after a schema change. */
export async function installReadingList(stack: Stack): Promise<void> {
  for (const handle of [Shelf, BookV1, Book, Review]) await stack.defineType(handle);
  await stack.migrateAll(Book.baseId);
}

/** The same install, as a request from an app the owner doesn't run. */
export const manifest: AppManifest = {
  appId: APP_ID,
  name: 'Reading List',
  types: [Shelf, BookV1, Book, Review],
  requests: [
    ...[Shelf, Book, Review].map(
      (handle): InstallRequest => ({
        baseId: handle.baseId,
        actions: ['create', 'read-own', 'update-own', 'delete-own'],
      }),
    ),
    // Covers are uploads, and an upload is an `_attachment` record.
    { baseId: '_attachment', actions: ['create', 'read-own'] },
  ],
};

export class ReadingList {
  private readonly client: StackClient;
  readonly #books: Collection<BookContent>;
  readonly #shelves: Collection<ShelfContent>;
  readonly #reviews: Collection<ReviewContent>;

  constructor(client: StackClient) {
    this.client = client;
    this.#books = client.collection(Book);
    this.#shelves = client.collection(Shelf);
    this.#reviews = client.collection(Review);
  }

  // -------------------------------------------------------
  // Shelves and books
  // -------------------------------------------------------

  async addShelf(name: string): Promise<ShelfRecord> {
    return this.#shelves.create({ name }, { appId: APP_ID });
  }

  async shelves(): Promise<ShelfRecord[]> {
    const { records } = await this.#shelves.query({ sort: { contentField: 'name' } });
    return records;
  }

  async addBook(
    content: Omit<BookContent, 'status'> & { status?: BookStatus },
    opts: { shelf?: RecordId; tags?: string[] } = {},
  ): Promise<BookRecord> {
    return this.#books.create(
      { status: 'want', ...content },
      {
        appId: APP_ID,
        parentId: opts.shelf,
        associations: opts.tags?.map((label) => ({ kind: 'tag', label })),
      },
    );
  }

  async getBook(id: RecordId): Promise<BookRecord | null> {
    return this.#books.get(id);
  }

  async startReading(id: RecordId): Promise<BookRecord> {
    return this.#books.patchContent(id, { status: 'reading' });
  }

  /**
   * Marks a book finished only if nobody else changed it since `seen` was
   * read — the optimistic-concurrency path. Returns null on a lost race so
   * the caller can re-read and decide.
   */
  async finish(
    seen: BookRecord,
    opts: { rating?: number; on?: Date } = {},
  ): Promise<BookRecord | null> {
    const on = (opts.on ?? new Date()).toISOString().slice(0, 10);
    try {
      return await this.#books.patchContent(
        seen.id,
        { status: 'finished', finishedOn: on, rating: opts.rating ?? null },
        { ifVersion: seen.version },
      );
    } catch (err) {
      if (err instanceof StackVersionConflictError) return null;
      throw err;
    }
  }

  async moveToShelf(id: RecordId, shelf: RecordId | null): Promise<BookRecord> {
    return this.#books.setParent(id, shelf);
  }

  async tag(id: RecordId, label: string): Promise<BookRecord> {
    return this.#books.editAssociations(id, [{ op: 'add', association: { kind: 'tag', label } }]);
  }

  async untag(id: RecordId, label: string): Promise<BookRecord> {
    return this.#books.editAssociations(id, [
      { op: 'remove', association: { kind: 'tag', label } },
    ]);
  }

  async linkIsbn(id: RecordId, isbn: string): Promise<BookRecord> {
    return this.#books.editAssociations(id, [
      {
        op: 'add',
        association: {
          kind: 'relationship',
          label: 'same-as',
          target: { kind: 'external', ns: 'isbn', id: isbn },
        },
      },
    ]);
  }

  async findByIsbn(isbn: string): Promise<BookRecord | null> {
    const { records } = await this.#books.query({
      filter: {
        relatedTo: { label: 'same-as', target: { kind: 'external', ns: 'isbn', id: isbn } },
      },
      limit: 1,
    });
    return records[0] ?? null;
  }

  /**
   * Every matching book, following cursors until the last page. Books this
   * build can't read come back as misfits on an unfiltered list. A content
   * filter or sort leaves out versions it can't translate and says so in
   * `skipped` instead.
   */
  async listBooks(filter: BookFilter = {}): Promise<BookList> {
    const query: CollectionQuery<BookContent> = {
      filter: {
        ...(filter.status && { content: { status: filter.status } }),
        ...(filter.tag && { tags: [filter.tag] }),
        ...(filter.shelf && { parentId: filter.shelf }),
        ...(filter.search && { search: filter.search }),
      },
      sort: filter.sortBy === 'title' ? { contentField: 'title' } : { field: 'createdAt' },
      limit: filter.pageSize ?? 50,
    };
    const out: BookList = { books: [], misfits: [], skipped: { older: false, newer: false } };
    let cursor: string | undefined;
    do {
      const page = await this.#books.query({ ...query, cursor });
      out.books.push(...page.records);
      out.misfits.push(...page.misfits);
      if (page.skipped) out.skipped = page.skipped;
      cursor = page.cursor ?? undefined;
    } while (cursor);
    return out;
  }

  // -------------------------------------------------------
  // Reviews (relationships between records)
  // -------------------------------------------------------

  async review(bookId: RecordId, text: string): Promise<ReviewRecord> {
    return this.#reviews.create(
      { text },
      {
        appId: APP_ID,
        associations: [
          { kind: 'relationship', label: 'reviews', target: { kind: 'record', recordId: bookId } },
        ],
      },
    );
  }

  async reviewsOf(bookId: RecordId): Promise<ReviewRecord[]> {
    const { records } = await this.#reviews.query({
      filter: { relatedTo: { label: 'reviews', target: { kind: 'record', recordId: bookId } } },
    });
    return records;
  }

  // -------------------------------------------------------
  // Covers (attachments)
  // -------------------------------------------------------

  async setCover(bookId: RecordId, bytes: Uint8Array, mimeType: string): Promise<BookRecord> {
    const upload = await this.client.putAttachment(bytes, { mimeType, appId: APP_ID });
    const book = await this.#books.get(bookId);
    const previous = book?.associations?.find(
      (a) => a.kind === 'attachment' && a.label === 'cover',
    );
    return this.#books.editAssociations(bookId, [
      ...(previous ? [{ op: 'remove' as const, association: previous }] : []),
      {
        op: 'add',
        association: {
          kind: 'attachment',
          label: 'cover',
          fileId: upload.content.fileId,
          attachmentRecordId: upload.id,
        },
      },
    ]);
  }

  async getCover(bookId: RecordId): Promise<Uint8Array | null> {
    const book = await this.#books.get(bookId);
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
    return { versions, journal };
  }

  /** A pre-migration snapshot restores as book@1 and reads back migrated. */
  async revert(id: RecordId, version: number): Promise<BookRecord> {
    return this.#books.restoreVersion(id, version);
  }

  async remove(id: RecordId): Promise<void> {
    await this.#books.delete(id);
  }

  async restore(id: RecordId): Promise<BookRecord> {
    return this.#books.undelete(id);
  }

  async onBookChange(
    handler: (change: CollectionChange<BookContent>) => void,
  ): Promise<Unsubscribe> {
    return this.#books.subscribe(handler, { includeRecords: true });
  }
}

// -------------------------------------------------------
// Sharing (owner-only, so it takes the full Stack)
// -------------------------------------------------------

/** Lets `friend` read every book and review, and nothing else. */
export async function shareLibraryWith(stack: Stack, friend: EntityId): Promise<void> {
  const grantee = { kind: 'entity', entityId: friend } as const;
  await stack.grantType(Book.baseId, { actions: ['read-any'], grantee });
  await stack.grantType(Review.baseId, { actions: ['read-any'], grantee });
}

/** Lets `friend` edit one book. `write` never implies `read`, so both are named. */
export async function letEdit(stack: Stack, bookId: RecordId, friend: EntityId): Promise<void> {
  const grantee = { kind: 'entity', entityId: friend } as const;
  await stack.editAccess(bookId, [
    { op: 'add', association: { kind: 'permission', label: 'read', grantee } },
    { op: 'add', association: { kind: 'permission', label: 'write', grantee } },
  ]);
}
