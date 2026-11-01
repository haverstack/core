/**
 * Stack copy conformance suite
 * -------------------------------------------------------
 * The copy a move between hosts makes: a stack with a past is written
 * through Stack into a source store, then copied with copyStack() into one
 * the adapter under test creates. Every Record, version snapshot, journal
 * entry, Type and blob must arrive as it was. The source is the adapter
 * under test too unless `source` names another engine, so a suite can hold
 * an adapter to the read half, the write half, or both. Point it at a full
 * StackAdapter that implements importRecord(). See docs/spec/portability.md.
 */

import { describe, test, expect } from 'vitest';
import { Stack, SYSTEM_TYPES } from '@haverstack/core';
import type { FileId, StackRecord } from '@haverstack/core';
import { copyStack, newStoreSeed, resolveQuery } from '@haverstack/core/adapter';
import type { CreateStore, StackAdapter } from '@haverstack/core/adapter';

export interface CopyConformanceOptions {
  /** Used in describe() titles, so pick something that reads well there. */
  name: string;
  /** Create a new store from this seed: the copy's target. */
  create: CreateStore;
  /** Create the store the stack is written into and copied from. Defaults to `create`. */
  source?: CreateStore;
  /** Release what either factory acquired. Called on every store they made. */
  close?: (adapter: StackAdapter) => Promise<void> | void;
}

const OWNER = 'did:key:conformance-owner';
const ALICE = { subjectId: 'did:key:conformance-alice' };
const BOB = { subjectId: 'did:key:conformance-bob', principalId: 'did:key:conformance-app' };
const NOTE = 'org.haverstack.conformance/copied-note@1';
const SEED = newStoreSeed({ ownerEntityId: OWNER });

/** Set order aside: an element set has no order to preserve. */
const bySerialized = <T>(list: T[] | undefined): T[] | undefined =>
  list && [...list].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

/** Everything a copy must carry, in a shape that compares with toEqual(). */
async function contentsOf(adapter: StackAdapter, fileIds: FileId[]) {
  const records: StackRecord[] = [];
  let cursor: string | undefined;
  do {
    const page = await adapter.queryRecords(
      resolveQuery({
        filter: { includeDeleted: true, includeUnlisted: true },
        cursor,
        limit: 100,
      }),
    );
    records.push(...page.records);
    cursor = page.cursor ?? undefined;
  } while (cursor);
  // `_config` is no query's, so it is read by id: it travels like the rest.
  const config = await adapter.getRecord(SYSTEM_TYPES.CONFIG);
  if (config) records.push(config);
  records.sort((a, b) => a.id.localeCompare(b.id));

  const blobs: Record<string, Uint8Array> = {};
  for (const fileId of fileIds) blobs[fileId] = await adapter.getBlob(fileId);

  return {
    types: (await adapter.listTypes()).sort((a, b) => a.id.localeCompare(b.id)),
    records: await Promise.all(
      records.map(async (record) => ({
        record: {
          ...record,
          associations: bySerialized(record.associations),
          permissions: bySerialized(record.permissions),
        },
        versions: await adapter.getVersions(record.id),
        journal: await adapter.getJournal(record.id),
      })),
    ),
    blobs,
  };
}

/**
 * A stack touched by every kind of write: foreign authorship, edits by an
 * app acting for someone, containment, tags, sharing, listing, an
 * attachment, bytes a content field names with no metadata record, a soft
 * delete, a purge, and a `_config` with a past of its own. Answers with the
 * blobs it wrote.
 */
async function writePast(adapter: StackAdapter): Promise<FileId[]> {
  const stack = await Stack.open(adapter, { ownerProfile: { name: 'Conformance Owner' } });
  await stack.defineType({
    id: NOTE,
    name: 'Note',
    schema: { title: { kind: 'text' }, cover: { kind: 'file-ref' } },
  });

  await stack.editAssociations(
    SYSTEM_TYPES.CONFIG,
    [{ op: 'add', association: { kind: 'tag', label: 'copied' } }],
    { actor: BOB },
  );

  const box = await stack.create(NOTE, { title: 'box' });
  const note = await stack.create(NOTE, { title: 'v1' }, { createdBy: ALICE });
  await stack.patchContent(note.id, { title: 'v2' }, { actor: BOB });
  await stack.setParent(note.id, box.id, { actor: BOB });
  await stack.editAssociations(note.id, [
    { op: 'add', association: { kind: 'tag', label: 'pinned' } },
  ]);
  await stack.editAccess(note.id, [{ op: 'add', association: { kind: 'anyone', label: 'read' } }]);
  await stack.setUnlisted(note.id, true);

  const attached = await stack.putAttachment(new TextEncoder().encode('attached bytes'), {
    mimeType: 'text/plain',
    filename: 'notes.txt',
  });
  const bare = await adapter.putBlob(new TextEncoder().encode('bytes with no metadata'));
  await stack.create(NOTE, { title: 'covered', cover: bare });

  const removed = await stack.create(NOTE, { title: 'removed' }, { createdBy: ALICE });
  await stack.delete(removed.id);
  const purged = await stack.create(NOTE, { title: 'purged' });
  await stack.delete(purged.id, { purge: true });
  return [attached.content.fileId, bare];
}

export function runCopyConformance(options: CopyConformanceOptions): void {
  const { name, create, source: createSource = create, close } = options;

  describe(`stack copy conformance: ${name}`, () => {
    test('implements importRecord()', async () => {
      const store = await create(SEED);
      try {
        expect(store.importRecord).toBeTypeOf('function');
      } finally {
        await close?.(store);
      }
    });

    test('a copy carries every Record, version, journal entry, Type and blob unchanged', async () => {
      const source = await createSource(SEED);
      let target: StackAdapter | undefined;
      try {
        const fileIds = await writePast(source);
        const expected = await contentsOf(source, fileIds);
        expect(expected.records.length).toBeGreaterThan(3);

        target = await copyStack(source, create);
        expect(await contentsOf(target, fileIds)).toEqual(expected);
      } finally {
        await close?.(source);
        if (target) await close?.(target);
      }
    });
  });
}
