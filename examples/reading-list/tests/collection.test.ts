import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Stack, StackBadRequestError, typeHandle } from '@haverstack/core';
import type { ContentOf } from '@haverstack/core';
import { generateDidKeypair } from '@haverstack/core/did';
import { MemoryAdapter } from '@haverstack/core/testing';
import { Collection, MisfitError, collection } from '../src/collection.ts';
import type { CollectionChange } from '../src/collection.ts';
import { Book, BookV1, Shelf } from '../src/schema.ts';
import {
  installReadingList,
  migrations,
  registerReadingListMigrations,
} from '../src/reading-list.ts';

const owner = await generateDidKeypair();

/** What a newer build of the app ships: one more status, then a new version. */
const BookWithPaused = typeHandle(Book.id, {
  ...Book.schema,
  status: { ...Book.schema.status, enum: [...Book.schema.status.enum, 'paused'] },
});
const BookV3 = typeHandle('com.example.reading/book@3', {
  ...Book.schema,
  subtitle: { kind: 'string' },
});

describe('Collection', () => {
  let stack: Stack;
  let books: Collection<ContentOf<typeof Book.schema>>;

  beforeEach(async () => {
    stack = await Stack.open(await MemoryAdapter.open({ ownerEntityId: owner.did }));
    registerReadingListMigrations(stack);
    await installReadingList(stack);
    books = collection(stack, Book, { migrations });
  });

  afterEach(async () => {
    await stack.close();
  });

  const writeNewerBooks = async () => {
    await stack.defineType({ ...BookWithPaused, name: 'Book' });
    const paused = await stack.create(BookWithPaused, {
      title: 'Paused',
      author: 'x',
      status: 'paused',
    });
    await stack.defineType({ ...BookV3, name: 'Book', migratesFrom: Book.id });
    const v3 = await stack.create(BookV3, { title: 'Newer', author: 'x', status: 'want' });
    return { paused, v3 };
  };

  it('reports records it cannot type beside the ones it can, and keeps paging', async () => {
    for (const title of ['A', 'B', 'C']) await books.create({ title, author: 'x', status: 'want' });
    const { paused, v3 } = await writeNewerBooks();

    const titles: string[] = [];
    const misfits: [string, string][] = [];
    let cursor: string | undefined;
    do {
      const page = await books.query({ sort: { contentField: 'title' }, limit: 2, cursor });
      titles.push(...page.records.map((r) => r.content.title));
      misfits.push(...page.misfits.map((m): [string, string] => [m.id, m.reason]));
      cursor = page.cursor ?? undefined;
    } while (cursor);

    expect(titles).toEqual(['A', 'B', 'C']);
    expect(misfits).toEqual(
      expect.arrayContaining([
        [paused.id, 'unknown-enum'],
        [v3.id, 'newer-version'],
      ]),
    );
  });

  it('get() throws MisfitError for a misfit and answers null outside the family', async () => {
    const { paused, v3 } = await writeNewerBooks();
    const shelf = await stack.create(Shelf, { name: 'Fiction' });

    await expect(books.get(paused.id)).rejects.toMatchObject({
      misfit: { reason: 'unknown-enum', errors: [{ path: 'status' }] },
    });
    await expect(books.get(v3.id)).rejects.toThrow(MisfitError);
    expect(await books.get(shelf.id)).toBeNull();
  });

  it('migrates an older record in memory on every read path', async () => {
    const old = await stack.create(BookV1, { title: 'Dune', author: 'x', status: 'done' });

    expect((await books.get(old.id))?.content.status).toBe('finished');
    expect((await books.query()).records.map((r) => r.content.status)).toEqual(['finished']);
  });

  it('refuses a patch to an older stored version before writing, naming the remedy', async () => {
    const old = await stack.create(BookV1, { title: 'Dune', author: 'x', status: 'done' });
    await expect(books.patchContent(old.id, { rating: 5 })).rejects.toThrow(/migrateAll/);
    expect((await stack.get(old.id))?.version).toBe(1);
  });

  it('types association and lifecycle writes without a re-read', async () => {
    const book = await books.create({ title: 'Emma', author: 'x', status: 'want' });
    const tagged = await books.associate(book.id, [{ kind: 'tag', label: 'classic' }]);
    expect(tagged.content.status).toBe('want');
    await books.delete(book.id);
    expect((await books.undelete(book.id)).content.title).toBe('Emma');
  });

  it('refuses to delete a record outside the family', async () => {
    const shelf = await stack.create(Shelf, { name: 'Fiction' });
    await expect(books.delete(shelf.id)).rejects.toThrow(StackBadRequestError);
    expect(await stack.get(shelf.id)).not.toBeNull();
  });

  it('restores a pre-migration snapshot as a typed, migrated record', async () => {
    await stack.close();
    stack = await Stack.open(await MemoryAdapter.open({ ownerEntityId: owner.did }));
    await stack.defineType({ ...BookV1, name: 'Book' });
    const old = await stack.create(BookV1, { title: 'Dune', author: 'x', status: 'done' });
    registerReadingListMigrations(stack);
    await installReadingList(stack);
    books = collection(stack, Book, { migrations });

    const restored = await books.restoreVersion(old.id, 1);
    expect(restored.typeId).toBe(Book.id);
    expect(restored.content.status).toBe('finished');
  });

  it('subscribes to the whole family, migrating older records and reporting misfits', async () => {
    const seen: CollectionChange<ContentOf<typeof Book.schema>>[] = [];
    const unsubscribe = await books.subscribe((c) => seen.push(c), { includeRecords: true });
    const old = await stack.create(BookV1, { title: 'Dune', author: 'x', status: 'done' });
    await stack.delete(old.id);
    const { paused } = await writeNewerBooks();
    unsubscribe();

    expect(
      seen.map((c) => [
        c.kind,
        c.typeId,
        c.record?.content.status ?? null,
        c.misfit?.reason ?? null,
      ]),
    ).toEqual([
      ['created', BookV1.id, 'finished', null],
      ['removed', BookV1.id, null, null],
      ['created', Book.id, null, 'unknown-enum'],
      ['created', BookV3.id, null, 'newer-version'],
    ]);
    expect(seen[2].misfit?.id).toBe(paused.id);
  });

  it('checks filters and sorts against the schema at compile time', () => {
    const Thing = typeHandle('com.example.test/thing@1', {
      name: { kind: 'string', required: true },
      size: { kind: 'number' },
      kind: { kind: 'string', enum: ['a', 'b'] },
      address: {
        kind: 'object',
        properties: { city: { kind: 'string' }, zip: { kind: 'number' } },
      },
      emails: {
        kind: 'array',
        items: { kind: 'object', properties: { value: { kind: 'string' } } },
      },
      tags: { kind: 'array', items: { kind: 'string' } },
      extra: { kind: 'object', open: true },
    });
    const typeChecks = (things: Collection<ContentOf<typeof Thing.schema>>) => {
      void things.query({
        filter: {
          content: {
            name: 'x',
            kind: 'a',
            size: null,
            'address.city': 'Paris',
            'emails.value': 'a@example.com',
            tags: 'starred',
            'extra.anything.deep': 1,
          },
          contentPresent: ['address.zip', 'extra.whatever'],
        },
        sort: { contentField: 'size' },
      });
      // @ts-expect-error a typo'd field
      void things.query({ filter: { content: { nmae: 'x' } } });
      // @ts-expect-error a value outside the enum
      void things.query({ filter: { content: { kind: 'c' } } });
      // @ts-expect-error a number field matched against a string
      void things.query({ filter: { content: { 'address.zip': '75001' } } });
      // @ts-expect-error a path through a scalar
      void things.query({ filter: { content: { 'name.first': 'x' } } });
      // @ts-expect-error a required field can't be removed
      void things.patchContent('x', { name: null });
      void things.patchContent('x', { size: null });
      // @ts-expect-error only top-level scalars sort
      void things.query({ sort: { contentField: 'address' } });
      // @ts-expect-error a typo'd sort field
      void things.query({ sort: { contentField: 'sise' } });
    };
    expect(Thing.baseId).toBe('com.example.test/thing');
    expect(typeChecks).toBeTypeOf('function');
  });
});
