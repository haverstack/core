/**
 * ReadingList — a small personal book tracker built on @haverstack/core
 * -------------------------------------------------------
 * The app layer a real consumer would write: it owns its types, wraps the
 * generic record API in domain verbs, and never touches an adapter
 * directly. It exists to exercise the Stack API the way an app author
 * meets it, so the places where it still has to work around the library
 * are left visible and cross-referenced to FINDINGS-2.md.
 *
 * Three layers, as the root README's "Writing an app" lays out: an install
 * function (owner, once per schema change), a startup function (every
 * open), and a data layer over `StackClient`, so the same class serves the
 * owner and a friend reading through `stack.asEntity()`.
 */

import type {
  EntityId,
  RecordId,
  RecordJournalEntry,
  RecordVersion,
  Stack,
  StackClient,
  StackRecord,
  TypedChange,
  TypedQuery,
  TypedRecord,
  Unsubscribe,
} from '@haverstack/core';
import { StackVersionConflictError } from '@haverstack/core';
import { Book, BookV1, Review, Shelf } from './schema.ts';
import type { BookContent, BookStatus } from './schema.ts';

export const APP_ID = 'com.example.reading';

export type BookRecord = TypedRecord<typeof Book.schema>;
export type ShelfRecord = TypedRecord<typeof Shelf.schema>;
export type ReviewRecord = TypedRecord<typeof Review.schema>;

export type BookFilter = {
  status?: BookStatus;
  tag?: string;
  shelf?: RecordId;
  search?: string;
  sortBy?: 'title' | 'added';
  pageSize?: number;
};

/** Every startup, right after Stack.open(): the registry lives in memory. */
export function registerReadingListMigrations(stack: Stack): void {
  stack.registerMigration({
    from: BookV1.id,
    to: Book.id,
    migrate: (c) => ({ ...c, status: c.status === 'done' ? 'finished' : c.status }),
  });
}

/** Owner-only, once per stack and again after a schema change. */
export async function installReadingList(stack: Stack): Promise<void> {
  await stack.defineType({ ...Shelf, name: 'Shelf' });
  await stack.defineType({ ...BookV1, name: 'Book' });
  await stack.defineType({ ...Book, name: 'Book', migratesFrom: BookV1.id });
  await stack.defineType({ ...Review, name: 'Review' });
  await stack.migrateAll(Book.baseId);
}

export class ReadingList {
  private readonly client: StackClient;

  constructor(client: StackClient) {
    this.client = client;
  }

  // -------------------------------------------------------
  // Shelves and books
  // -------------------------------------------------------

  async addShelf(name: string): Promise<ShelfRecord> {
    return this.client.create(Shelf, { name }, { appId: APP_ID });
  }

  async shelves(): Promise<ShelfRecord[]> {
    const { records } = await this.client.query(Shelf, { sort: { contentField: 'name' } });
    return records;
  }

  async addBook(
    content: Omit<BookContent, 'status'> & { status?: BookStatus },
    opts: { shelf?: RecordId; tags?: string[] } = {},
  ): Promise<BookRecord> {
    return this.client.create(
      Book,
      { status: 'want', ...content },
      {
        appId: APP_ID,
        parentId: opts.shelf,
        associations: opts.tags?.map((label) => ({ kind: 'tag', label })),
      },
    );
  }

  async getBook(id: RecordId): Promise<BookRecord | null> {
    return this.client.get(Book, id);
  }

  async startReading(id: RecordId): Promise<BookRecord> {
    return this.client.patchContent(Book, id, { status: 'reading' });
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
      return await this.client.patchContent(
        Book,
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
    return this.client.mutate(Book, id, { parentId: shelf });
  }

  async tag(id: RecordId, label: string): Promise<BookRecord> {
    return this.typed(await this.client.associate(id, [{ kind: 'tag', label }]));
  }

  async untag(id: RecordId, label: string): Promise<BookRecord> {
    return this.typed(await this.client.dissociate(id, [{ kind: 'tag', label }]));
  }

  async linkIsbn(id: RecordId, isbn: string): Promise<BookRecord> {
    return this.typed(
      await this.client.associate(id, [
        {
          kind: 'relationship',
          label: 'same-as',
          target: { kind: 'external', ns: 'isbn', id: isbn },
        },
      ]),
    );
  }

  async findByIsbn(isbn: string): Promise<BookRecord | null> {
    const { records } = await this.client.query(Book, {
      filter: {
        relatedTo: { label: 'same-as', target: { kind: 'external', ns: 'isbn', id: isbn } },
      },
      limit: 1,
    });
    return records[0] ?? null;
  }

  /** Every matching book, following cursors until the last page. */
  async *books(filter: BookFilter = {}): AsyncGenerator<BookRecord> {
    const query: TypedQuery = {
      filter: {
        ...(filter.status && { content: { status: filter.status } }),
        ...(filter.tag && { tags: [filter.tag] }),
        ...(filter.shelf && { parentId: filter.shelf }),
        ...(filter.search && { search: filter.search }),
      },
      sort: filter.sortBy === 'title' ? { contentField: 'title' } : { field: 'createdAt' },
      limit: filter.pageSize ?? 50,
    };
    let cursor: string | undefined;
    do {
      const page = await this.client.query(Book, { ...query, cursor });
      yield* page.records;
      cursor = page.cursor ?? undefined;
    } while (cursor);
  }

  async listBooks(filter: BookFilter = {}): Promise<BookRecord[]> {
    const out: BookRecord[] = [];
    for await (const book of this.books(filter)) out.push(book);
    return out;
  }

  // -------------------------------------------------------
  // Reviews (relationships between records)
  // -------------------------------------------------------

  async review(bookId: RecordId, text: string): Promise<ReviewRecord> {
    return this.client.create(
      Review,
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
    const { records } = await this.client.query(Review, {
      filter: { relatedTo: { label: 'reviews', target: { kind: 'record', recordId: bookId } } },
    });
    return records;
  }

  // -------------------------------------------------------
  // Covers (attachments)
  // -------------------------------------------------------

  async setCover(bookId: RecordId, bytes: Uint8Array, mimeType: string): Promise<BookRecord> {
    const upload = await this.client.putAttachment(bytes, { mimeType, appId: APP_ID });
    const book = await this.client.get(bookId);
    const previous = book?.associations?.find(
      (a) => a.kind === 'attachment' && a.label === 'cover',
    );
    return this.typed(
      await this.client.amendAssociations(bookId, [
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
      ]),
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
    return { versions, journal };
  }

  async revert(id: RecordId, version: number): Promise<StackRecord> {
    // A pre-migration snapshot restores as book@1, so the result is not
    // necessarily a Book@2 and cannot be returned typed.
    return this.client.restoreVersion(id, version);
  }

  async remove(id: RecordId): Promise<void> {
    await this.client.delete(id);
  }

  async restore(id: RecordId): Promise<BookRecord> {
    return this.typed(await this.client.undelete(id));
  }

  async onBookChange(
    handler: (change: TypedChange<typeof Book.schema>) => void,
  ): Promise<Unsubscribe> {
    return this.client.subscribe(Book, handler);
  }

  /**
   * The association and lifecycle verbs have no typed overload, so their
   * result is re-read through the handle. See FINDINGS-2.md.
   */
  private async typed(record: StackRecord): Promise<BookRecord> {
    const book = await this.client.get(Book, record.id);
    if (!book) throw new Error(`Book "${record.id}" vanished between write and read`);
    return book;
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
  await stack.grantAccess(bookId, [
    { kind: 'permission', label: 'read', grantee },
    { kind: 'permission', label: 'write', grantee },
  ]);
}
