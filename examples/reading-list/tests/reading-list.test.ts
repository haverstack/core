import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MisfitError,
  Stack,
  StackPermissionError,
  StackVersionConflictError,
  typeHandle,
} from '@haverstack/core';
import type { RecordChange } from '@haverstack/core';
import { generateDidKeypair } from '@haverstack/core/did';
import { MemoryAdapter } from '@haverstack/core/testing';
import { LocalAdapter } from '@haverstack/adapter-local';
import { Book, BookV1, Shelf, migrations } from '../src/schema.ts';
import {
  ReadingList,
  installReadingList,
  letEdit,
  manifest,
  shareLibraryWith,
} from '../src/reading-list.ts';

const owner = await generateDidKeypair();
const friend = await generateDidKeypair();

type Harness = { open: () => Promise<Stack>; cleanup: () => void };

const adapters: Record<string, () => Harness> = {
  memory: () => {
    const adapter = MemoryAdapter.open({ ownerEntityId: owner.did });
    return { open: async () => Stack.open(await adapter, { migrations }), cleanup: () => {} };
  },
  local: () => {
    const dir = mkdtempSync(join(tmpdir(), 'reading-list-test-'));
    const path = join(dir, 'stack.db');
    return {
      open: async () =>
        Stack.open(
          await LocalAdapter.open({ path, create: 'ifMissing', ownerEntityId: owner.did }),
          { migrations },
        ),
      cleanup: () => rmSync(dir, { recursive: true, force: true }),
    };
  },
};

describe.each(Object.entries(adapters))('ReadingList over %s adapter', (_name, make) => {
  let harness: Harness;
  let stack: Stack;
  let app: ReadingList;

  beforeEach(async () => {
    harness = make();
    stack = await harness.open();
    await installReadingList(stack);
    app = new ReadingList(stack);
  });

  afterEach(async () => {
    await stack.close();
    harness.cleanup();
  });

  it('migrates books written by the v1 schema on install', async () => {
    await stack.close();
    stack = await harness.open();
    await stack.defineType(BookV1);
    const old = await stack
      .collection(BookV1)
      .create({ title: 'Dune', author: 'Herbert', status: 'done' });
    await installReadingList(stack);

    const stored = await stack.get(old.id);
    expect(stored?.typeId).toBe(Book.id);
    expect(stored?.content.status).toBe('finished');
  });

  it('filters by status, tag, shelf and search', async () => {
    const shelf = await app.addShelf('Fiction');
    await app.addBook(
      { title: 'The Hobbit', author: 'Tolkien' },
      { shelf: shelf.id, tags: ['fantasy'] },
    );
    await app.addBook({ title: 'Emma', author: 'Austen', status: 'reading' });

    const titles = async (f: Parameters<ReadingList['listBooks']>[0]) =>
      (await app.listBooks(f)).books.map((b) => b.content.title);

    expect(await titles({ status: 'reading' })).toEqual(['Emma']);
    expect(await titles({ tag: 'fantasy' })).toEqual(['The Hobbit']);
    expect(await titles({ shelf: shelf.id })).toEqual(['The Hobbit']);
    if (stack.capabilities.filter.search) {
      expect(await titles({ search: 'hobbit' })).toEqual(['The Hobbit']);
    }
  });

  it('pages through every book in title order', async () => {
    for (const title of ['C', 'A', 'E', 'B', 'D']) await app.addBook({ title, author: 'x' });
    const { books } = await app.listBooks({ sortBy: 'title', pageSize: 2 });
    expect(books.map((b) => b.content.title)).toEqual(['A', 'B', 'C', 'D', 'E']);
  });

  it('refuses a finish based on a stale read', async () => {
    const book = await app.addBook({ title: 'Emma', author: 'Austen' });
    await app.startReading(book.id);
    expect(await app.finish(book)).toBeNull();

    const fresh = (await app.getBook(book.id))!;
    const done = await app.finish(fresh, { rating: 4, on: new Date('2026-01-02') });
    expect(done?.content).toMatchObject({
      status: 'finished',
      rating: 4,
      finishedOn: '2026-01-02',
    });
  });

  it('tagging does not invalidate a read held for ifVersion', async () => {
    const book = await app.addBook({ title: 'Emma', author: 'Austen' });
    await app.tag(book.id, 'classic');
    expect(await app.finish(book)).not.toBeNull();
  });

  it('replaces the cover rather than accumulating covers', async () => {
    const book = await app.addBook({ title: 'Emma', author: 'Austen' });
    await app.setCover(book.id, new Uint8Array([1]), 'image/png');
    const updated = await app.setCover(book.id, new Uint8Array([2]), 'image/png');

    expect(updated.associations?.filter((a) => a.kind === 'attachment')).toHaveLength(1);
    // Disk returns a Buffer, memory a plain Uint8Array; compare the bytes.
    expect([...((await app.getCover(book.id)) ?? [])]).toEqual([2]);
  });

  it('finds books by ISBN and reviews by the book they review', async () => {
    const book = await app.addBook({ title: 'Emma', author: 'Austen' });
    await app.linkIsbn(book.id, '9780141439587');
    await app.review(book.id, 'Sharp.');

    expect((await app.findByIsbn('9780141439587'))?.id).toBe(book.id);
    expect((await app.reviewsOf(book.id)).map((r) => r.content.text)).toEqual(['Sharp.']);
  });

  it('reports versions newest first, the journal oldest first, and reverts content', async () => {
    const book = await app.addBook({ title: 'Emma', author: 'Austen' });
    await app.startReading(book.id);
    await app.finish((await app.getBook(book.id))!);

    const { versions, journal } = await app.history(book.id);
    expect(versions.map((v) => v.content.status)).toEqual(['reading', 'want']);
    expect(journal.map((j) => j.ops[0])).toEqual(['create', 'patch', 'patch']);
    expect((await app.revert(book.id, 1)).content.status).toBe('want');
  });

  it('hides a deleted book until it is restored', async () => {
    const book = await app.addBook({ title: 'Emma', author: 'Austen' });
    await app.remove(book.id);
    expect(await app.getBook(book.id)).toBeNull();
    expect((await app.listBooks()).books).toEqual([]);
    await app.restore(book.id);
    expect((await app.getBook(book.id))?.content.title).toBe('Emma');
  });

  it('announces book changes to a subscriber', async () => {
    const seen: RecordChange[] = [];
    const unsubscribe = await app.onBookChange((c) => seen.push(c));
    const book = await app.addBook({ title: 'Emma', author: 'Austen' });
    await app.tag(book.id, 'classic');
    await app.addShelf('ignored — not a book');
    unsubscribe();

    expect(seen.map((c) => [c.kind, c.ops])).toEqual([
      ['created', ['create']],
      ['changed', ['associate']],
    ]);
  });

  it('lets a friend read shared books but edit only where granted', async () => {
    const book = await app.addBook({ title: 'Emma', author: 'Austen' });
    const other = await app.addBook({ title: 'Dune', author: 'Herbert' });
    const asFriend = new ReadingList(stack.asEntity(friend.did));

    expect((await asFriend.listBooks()).books).toEqual([]);
    await shareLibraryWith(stack, friend.did);
    expect((await asFriend.listBooks()).books).toHaveLength(2);

    await expect(asFriend.startReading(book.id)).rejects.toThrow(StackPermissionError);
    await letEdit(stack, book.id, friend.did);
    const edited = await asFriend.startReading(book.id);
    expect(edited.updatedBy?.subjectId).toBe(friend.did);
    await expect(asFriend.startReading(other.id)).rejects.toThrow(StackPermissionError);
  });

  it('installs from the manifest for an app the owner does not run', async () => {
    const appKey = await generateDidKeypair();
    const plan = await stack.planInstall(manifest, { did: appKey.did });
    await stack.installApp(manifest, { did: appKey.did, fingerprint: plan.fingerprint });
    const asApp = new ReadingList(stack.asEntity(appKey.did));

    const book = await asApp.addBook({ title: 'Emma', author: 'Austen' });
    await asApp.setCover(book.id, new Uint8Array([1]), 'image/png');
    expect([...((await asApp.getCover(book.id)) ?? [])]).toEqual([1]);
    await expect(asApp.review(book.id, 'Sharp.')).resolves.toBeDefined();
  });

  describe('records written by other builds', () => {
    /** What a newer build ships: one more status in place, then book@3. */
    const BookWithPaused = typeHandle({
      ...Book,
      schema: {
        ...Book.schema,
        status: { ...Book.schema.status, values: [...Book.schema.status.values, 'paused'] },
      },
    });
    const BookV3 = typeHandle({
      id: 'com.example.reading/book@3',
      name: 'Book',
      migratesFrom: BookWithPaused,
      schema: { ...BookWithPaused.schema, subtitle: { kind: 'string' } },
    });

    const writeNewerBooks = async () => {
      await stack.defineType(BookWithPaused);
      const paused = await stack
        .collection(BookWithPaused)
        .create({ title: 'Paused', author: 'x', status: 'paused' });
      await stack.defineType(BookV3);
      // Untyped: this process has no @2→@3 migration, so it can't open a collection on @3.
      const v3 = await stack.create(BookV3.id, { title: 'Newer', author: 'x', status: 'want' });
      return { paused, v3 };
    };

    const writeV1Book = () =>
      stack.collection(BookV1).create({ title: 'Dune', author: 'x', status: 'done' });

    it('lists a newer version as a misfit and keeps paging', async () => {
      for (const title of ['A', 'B', 'C']) await app.addBook({ title, author: 'x' });
      const { v3 } = await writeNewerBooks();

      const { books, misfits } = await app.listBooks({ pageSize: 2 });
      expect(books.map((b) => b.content.title)).toEqual(['A', 'B', 'C', 'Paused']);
      expect(misfits.map((m) => [m.id, m.reason])).toEqual([[v3.id, 'newer-version']]);
    });

    it('leaves a newer version out of a content sort and flags it as skipped', async () => {
      await app.addBook({ title: 'A', author: 'x' });
      await writeNewerBooks();

      const { books, misfits, skipped } = await app.listBooks({ sortBy: 'title' });
      expect(books.map((b) => b.content.title)).toEqual(['A', 'Paused']);
      expect(misfits).toEqual([]);
      expect(skipped.newer).toBe(true);
    });

    it('leaves a v1 book out of a status filter, since status is derived, and flags it', async () => {
      await writeV1Book();
      const { books, skipped } = await app.listBooks({ status: 'finished' });
      expect(books).toEqual([]);
      expect(skipped.older).toBe(true);
    });

    it('reads an unlisted enum value as a string rather than a misfit', async () => {
      const { paused, v3 } = await writeNewerBooks();
      expect((await app.getBook(paused.id))?.content.status).toBe('paused');
      await expect(app.getBook(v3.id)).rejects.toThrow(MisfitError);
    });

    it('answers null for a record outside the family', async () => {
      const shelf = await app.addShelf('Fiction');
      expect(await app.getBook(shelf.id)).toBeNull();
    });

    it('migrates an older record in memory on every read path', async () => {
      const old = await writeV1Book();
      expect((await app.getBook(old.id))?.content.status).toBe('finished');
      expect((await app.listBooks()).books.map((b) => b.content.status)).toEqual(['finished']);
    });

    it('commits the migration as its own write before a patch', async () => {
      const old = await writeV1Book();
      const patched = await app.finish(
        { ...(await app.getBook(old.id))!, version: 1 },
        {
          rating: 5,
        },
      );

      expect(patched).toMatchObject({ typeId: Book.id, version: 3 });
      expect((await stack.getJournal(old.id)).map((j) => j.ops)).toEqual([
        ['create'],
        ['migrate'],
        ['patch'],
      ]);
    });

    it("fences the migration with the caller's ifVersion", async () => {
      const old = await writeV1Book();
      await expect(
        stack.collection(Book).patchContent(old.id, { rating: 5 }, { ifVersion: 7 }),
      ).rejects.toThrow(StackVersionConflictError);
      expect((await stack.get(old.id))?.typeId).toBe(BookV1.id);
    });

    it('refuses, without writing, a patch from someone who may not migrate', async () => {
      const old = await writeV1Book();
      await shareLibraryWith(stack, friend.did);
      await letEdit(stack, old.id, friend.did);

      await expect(
        new ReadingList(stack.asEntity(friend.did)).startReading(old.id),
      ).rejects.toThrow(/book@1/);
      expect(await stack.get(old.id)).toMatchObject({ typeId: BookV1.id, version: 1 });
    });

    it('delivers the whole family to a subscriber, migrated, with misfits reported', async () => {
      const seen: [string, string | null, string | null][] = [];
      const unsubscribe = await app.onBookChange((c) =>
        seen.push([c.kind, c.record?.content.status ?? null, c.misfit?.reason ?? null]),
      );
      await writeV1Book();
      await writeNewerBooks();
      unsubscribe();

      expect(seen).toEqual([
        ['created', 'finished', null],
        ['created', 'paused', null],
        ['created', null, 'newer-version'],
      ]);
    });

    it('refuses a delete through the collection for a record outside the family', async () => {
      const shelf = await stack.collection(Shelf).create({ name: 'Fiction' });
      await expect(stack.collection(Book).delete(shelf.id)).rejects.toThrow();
      expect(await stack.get(shelf.id)).not.toBeNull();
    });
  });
});
