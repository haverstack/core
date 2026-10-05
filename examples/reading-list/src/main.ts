/**
 * Runnable walkthrough: `pnpm start` from this directory (after
 * `pnpm run build` at the repo root). Creates a throwaway stack on disk,
 * lets a "v1" build of the app write to it, then opens it with the current
 * build and exercises each part of the API in turn, printing as it goes.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Stack, StackError, typeHandle } from '@haverstack/core';
import { generateDidKeypair } from '@haverstack/core/did';
import { LocalAdapter } from '@haverstack/adapter-local';
import { Book, BookV1 } from './schema.ts';
import {
  ReadingList,
  installReadingList,
  letEdit,
  registerReadingListMigrations,
  shareLibraryWith,
} from './reading-list.ts';

const step = (title: string) => console.log(`\n── ${title}`);
const show = (label: string, value: unknown) =>
  console.log(`   ${label}:`, typeof value === 'string' ? value : JSON.stringify(value));

const dir = await mkdtemp(join(tmpdir(), 'reading-list-'));
const path = join(dir, 'stack.db');
const me = await generateDidKeypair();
const friend = await generateDidKeypair();

try {
  step('A v1 build of the app writes two books');
  {
    const adapter = await LocalAdapter.open({ path, create: 'exclusive', ownerEntityId: me.did });
    const stack = await Stack.open(adapter, { ownerProfile: { name: 'Jen' } });
    await stack.defineType({ ...BookV1, name: 'Book' });
    await stack.create(BookV1, { title: 'Dune', author: 'Frank Herbert', status: 'done' });
    await stack.create(BookV1, { title: 'Piranesi', author: 'Susanna Clarke', status: 'want' });
    await stack.close();
  }

  step('The current build opens the same file and migrates');
  const stack = await Stack.open(await LocalAdapter.open({ path }));
  registerReadingListMigrations(stack);
  await installReadingList(stack);
  const app = new ReadingList(stack);
  show('owner', (await stack.getOwnerEntity())?.content.name);
  for (const b of (await app.listBooks()).books)
    show(b.typeId, `${b.content.title} — ${b.content.status}`);

  step('Shelves, books, tags');
  const fiction = await app.addShelf('Fiction');
  const nonfiction = await app.addShelf('Non-fiction');
  const hobbit = await app.addBook(
    { title: 'The Hobbit', author: 'J.R.R. Tolkien', pages: 310 },
    { shelf: fiction.id, tags: ['fantasy', 'reread'] },
  );
  await app.addBook(
    { title: 'Thinking, Fast and Slow', author: 'Daniel Kahneman' },
    { shelf: nonfiction.id },
  );
  await app.linkIsbn(hobbit.id, '9780547928227');
  show(
    'shelves',
    (await app.shelves()).map((s) => s.content.name),
  );
  show('found by ISBN', (await app.findByIsbn('9780547928227'))?.content.title);
  show(
    'tagged fantasy',
    (await app.listBooks({ tag: 'fantasy' })).books.map((b) => b.content.title),
  );
  show(
    'full-text "slow"',
    (await app.listBooks({ search: 'slow' })).books.map((b) => b.content.title),
  );

  step('Watching for changes');
  const seen: string[] = [];
  const unsubscribe = await app.onBookChange((c) => seen.push(`${c.kind}/${c.ops.join('+')}`));

  step('Reading, then finishing with optimistic concurrency');
  const reading = await app.startReading(hobbit.id);
  show('status', reading.content.status);
  const stale = reading;
  await app.tag(hobbit.id, 'favourite'); // doesn't bump version, so `stale` is still current
  const finished = await app.finish(stale, { rating: 5 });
  show('finished', finished && { status: finished.content.status, v: finished.version });
  const lost = await app.finish(stale, { rating: 1 });
  show('second finish from a stale read', lost === null ? 'refused (version conflict)' : lost);

  step('Moving between shelves');
  const moved = await app.moveToShelf(hobbit.id, nonfiction.id);
  show('parentId is now Non-fiction', moved.parentId === nonfiction.id);
  show(
    'sorted by title',
    (await app.listBooks({ sortBy: 'title' })).books.map((b) => b.content.title),
  );

  step('Cover image (attachment)');
  await app.setCover(hobbit.id, new TextEncoder().encode('<png bytes>'), 'image/png');
  await app.setCover(hobbit.id, new TextEncoder().encode('<better png>'), 'image/png');
  show('cover', new TextDecoder().decode((await app.getCover(hobbit.id)) ?? new Uint8Array()));

  step('Reviews (record-to-record relationships)');
  await app.review(hobbit.id, 'Cosy and brisk.');
  show(
    'reviews',
    (await app.reviewsOf(hobbit.id)).map((r) => r.content.text),
  );

  step('History and revert');
  const { versions, journal } = await app.history(hobbit.id);
  show(
    'versions',
    versions.map((v) => `v${v.version}:${v.content.status}`),
  );
  show(
    'journal',
    journal.map((j) => j.ops.join('+')),
  );
  const reverted = await app.revert(hobbit.id, 1);
  show('after revert to v1', { status: reverted.content.status, version: reverted.version });

  step('Delete and undelete');
  await app.remove(hobbit.id);
  show('getBook after delete', await app.getBook(hobbit.id));
  show('restored', (await app.restore(hobbit.id)).content.title);

  step('Sharing with a friend');
  const friendView = new ReadingList(stack.asEntity(friend.did));
  show('friend sees before sharing', (await friendView.listBooks()).books.length);
  await shareLibraryWith(stack, friend.did);
  show('friend sees after sharing', (await friendView.listBooks()).books.length);
  try {
    await friendView.startReading(hobbit.id);
  } catch (err) {
    show('friend edit without write', err instanceof StackError ? err.code : err);
  }
  await letEdit(stack, hobbit.id, friend.did);
  const edited = await friendView.startReading(hobbit.id);
  show('friend edit with write, updatedBy', edited.updatedBy);

  unsubscribe();
  step('Change events seen while subscribed');
  show('events', seen);

  step('A newer build adds a status this build does not know');
  const BookWithPaused = typeHandle(Book.id, {
    ...Book.schema,
    status: { ...Book.schema.status, enum: [...Book.schema.status.enum, 'paused'] },
  });
  await stack.defineType({ ...BookWithPaused, name: 'Book' });
  await stack.create(BookWithPaused, {
    title: 'Middlemarch',
    author: 'George Eliot',
    status: 'paused',
  });
  const { books, misfits } = await app.listBooks();
  show('books this build can read', books.length);
  show(
    'misfits',
    misfits.map((m) => `${m.record.content.title}: ${m.reason}`),
  );

  await stack.close();
} finally {
  await rm(dir, { recursive: true, force: true });
}
