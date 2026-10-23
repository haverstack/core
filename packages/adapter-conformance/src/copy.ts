/**
 * Stack copy conformance suite
 * -------------------------------------------------------
 * The round trip a move between hosts makes: a stack with a past is
 * written through Stack, copied into the adapter under test with
 * copyStack(), and copied back out into a fresh MemoryAdapter. Every
 * Record, version snapshot, journal entry, Type and blob must come back
 * as it went in, at both hops. Point it at a full StackAdapter that
 * implements importRecord(). See docs/spec/portability.md.
 */

import { describe, test, expect } from 'vitest';
import { Stack, SYSTEM_TYPES } from '@haverstack/core';
import type { StackRecord } from '@haverstack/core';
import { copyStack, resolveQuery } from '@haverstack/core/adapter';
import type { StackAdapter } from '@haverstack/core/adapter';
import { MemoryAdapter } from '@haverstack/core/testing';

/** The identity a copy target is created with: the source stack's own. */
export type CopyTargetIdentity = { ownerEntityId: string; timezone: string | undefined };

export interface CopyConformanceOptions {
  /** Used in describe() titles, so pick something that reads well there. */
  name: string;
  /** Produce a fresh, empty adapter created with this identity. */
  open: (identity: CopyTargetIdentity) => Promise<StackAdapter> | StackAdapter;
  /** Release what `open()` acquired. Called after every test. */
  close?: (adapter: StackAdapter) => Promise<void> | void;
}

const OWNER = 'did:key:conformance-owner';
const ALICE = { subjectId: 'did:key:conformance-alice' };
const BOB = { subjectId: 'did:key:conformance-bob', principalId: 'did:key:conformance-app' };
const NOTE = 'org.haverstack.conformance/copied-note@1';

/** Set order aside: an element set has no order to preserve. */
const bySerialized = <T>(list: T[] | undefined): T[] | undefined =>
  list && [...list].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

/** Everything a copy must carry, in a shape that compares with toEqual(). */
async function contentsOf(adapter: StackAdapter) {
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
  records.sort((a, b) => a.id.localeCompare(b.id));

  const blobs: Record<string, Uint8Array> = {};
  for (const record of records) {
    if (record.typeId.startsWith(`${SYSTEM_TYPES.ATTACHMENT}@`)) {
      const fileId = (record.content as { fileId: string }).fileId;
      blobs[fileId] = await adapter.getBlob(fileId);
    }
  }

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
 * attachment, a soft delete and a purge.
 */
async function stackWithAPast(): Promise<MemoryAdapter> {
  const adapter = await MemoryAdapter.open({ ownerEntityId: OWNER, timezone: 'Europe/Paris' });
  const stack = await Stack.open(adapter, { ownerProfile: { name: 'Conformance Owner' } });
  await stack.defineType({ id: NOTE, name: 'Note', schema: { title: { kind: 'text' } } });

  const box = await stack.create(NOTE, { title: 'box' });
  const note = await stack.create(NOTE, { title: 'v1' }, { createdBy: ALICE });
  await stack.patchContent(note.id, { title: 'v2' }, { actor: BOB });
  await stack.setParent(note.id, box.id, { actor: BOB });
  await stack.editAssociations(note.id, [
    { op: 'add', association: { kind: 'tag', label: 'pinned' } },
  ]);
  await stack.editAccess(note.id, [{ op: 'add', association: { kind: 'anyone', label: 'read' } }]);
  await stack.setUnlisted(note.id, true);

  await stack.putAttachment(new TextEncoder().encode('attached bytes'), {
    mimeType: 'text/plain',
    filename: 'notes.txt',
  });

  const removed = await stack.create(NOTE, { title: 'removed' }, { createdBy: ALICE });
  await stack.delete(removed.id);
  const purged = await stack.create(NOTE, { title: 'purged' });
  await stack.delete(purged.id, { purge: true });
  return adapter;
}

export function runCopyConformance(options: CopyConformanceOptions): void {
  const { name, open, close } = options;

  describe(`stack copy conformance: ${name}`, () => {
    const identity = { ownerEntityId: OWNER, timezone: 'Europe/Paris' };

    test('implements importRecord()', async () => {
      const target = await open(identity);
      try {
        expect(target.importRecord).toBeTypeOf('function');
      } finally {
        await close?.(target);
      }
    });

    test('a copy in and back out carries every Record, version, journal entry, Type and blob unchanged', async () => {
      const source = await stackWithAPast();
      const expected = await contentsOf(source);
      expect(expected.records.length).toBeGreaterThan(3);
      expect(Object.keys(expected.blobs)).toHaveLength(1);

      const target = await open(identity);
      try {
        await copyStack(source, target);
        expect(await contentsOf(target)).toEqual(expected);

        const back = await MemoryAdapter.open(identity);
        await copyStack(target, back);
        expect(await contentsOf(back)).toEqual(expected);
      } finally {
        await close?.(target);
      }
    });
  });
}
