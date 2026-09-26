import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Stack, StackPermissionError } from '@haverstack/core';
import type { RecordChange } from '@haverstack/core';
import { generateDidKeypair } from '@haverstack/core/did';
import { MemoryAdapter } from '@haverstack/core/testing';
import { LocalAdapter } from '@haverstack/adapter-local';
import { BOOK, BOOK_V1, bookV1Type } from '../src/schema.ts';
import { ReadingList, installReadingList, letEdit, shareLibraryWith } from '../src/reading-list.ts';

const owner = await generateDidKeypair();
const friend = await generateDidKeypair();

type Harness = { open: () => Promise<Stack>; cleanup: () => void };

const adapters: Record<string, () => Harness> = {
  memory: () => {
    const adapter = new MemoryAdapter({ ownerEntityId: owner.did });
    return { open: () => Stack.open(adapter), cleanup: () => {} };
  },
  local: () => {
    const dir = mkdtempSync(join(tmpdir(), 'reading-list-test-'));
    const path = join(dir, 'stack.db');
    return {
      open: async () =>
        Stack.open(await LocalAdapter.openOrInitialize({ path, ownerEntityId: owner.did })),
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
    await stack.defineType(bookV1Type);
    const old = await stack.create(BOOK_V1, { title: 'Dune', author: 'Herbert', status: 'done' });
    await installReadingList(stack);

    const stored = await stack.get(old.id);
    expect(stored?.typeId).toBe(BOOK);
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
      (await app.listBooks(f)).map((b) => b.content.title);

    expect(await titles({ status: 'reading' })).toEqual(['Emma']);
    expect(await titles({ tag: 'fantasy' })).toEqual(['The Hobbit']);
    expect(await titles({ shelf: shelf.id })).toEqual(['The Hobbit']);
    if (stack.capabilities.filter.search) {
      expect(await titles({ search: 'hobbit' })).toEqual(['The Hobbit']);
    }
  });

  it('pages through every book in title order', async () => {
    for (const title of ['C', 'A', 'E', 'B', 'D']) await app.addBook({ title, author: 'x' });
    const books = await app.listBooks({ sortBy: 'title', pageSize: 2 });
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

  it('reports history oldest first and reverts content', async () => {
    const book = await app.addBook({ title: 'Emma', author: 'Austen' });
    await app.startReading(book.id);
    await app.finish((await app.getBook(book.id))!);

    const { versions, journal } = await app.history(book.id);
    expect(versions.map((v) => v.content.status)).toEqual(['want', 'reading']);
    expect(journal.map((j) => j.ops[0])).toEqual(['create', 'patch', 'patch']);
    expect((await app.revert(book.id, 1)).content.status).toBe('want');
  });

  it('hides a deleted book until it is restored', async () => {
    const book = await app.addBook({ title: 'Emma', author: 'Austen' });
    await app.remove(book.id);
    expect(await app.getBook(book.id)).toBeNull();
    expect(await app.listBooks()).toEqual([]);
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

    expect(await asFriend.listBooks()).toEqual([]);
    await shareLibraryWith(stack, friend.did);
    expect(await asFriend.listBooks()).toHaveLength(2);

    await expect(asFriend.startReading(book.id)).rejects.toThrow(StackPermissionError);
    await letEdit(stack, book.id, friend.did);
    const edited = await asFriend.startReading(book.id);
    expect(edited.updatedBy?.subjectId).toBe(friend.did);
    await expect(asFriend.startReading(other.id)).rejects.toThrow(StackPermissionError);
  });
});
