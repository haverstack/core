/**
 * A hosted stack as the source of a copy: copyStack() reads it through
 * APIAdapter the way it reads any adapter, so a group can leave its host
 * with the owner's credential alone. The server here is a MemoryAdapter
 * behind core's own wire encoders, so what arrives can be compared with
 * what it holds. See docs/spec/portability.md § Copying a stack.
 */
import { describe, test, expect } from 'vitest';
import { InvalidAdapterError, Stack, StackConflictError } from '@haverstack/core';
import { copyStack, resolveQuery } from '@haverstack/core/adapter';
import type { StoreSeed } from '@haverstack/core/adapter';
import { MemoryAdapter } from '@haverstack/core/testing';
import { parseBlobsParams, parseQueryBody } from '@haverstack/core/wire';
import {
  serializeBlobInfo,
  serializeJournalEntry,
  serializeRecord,
  serializeType,
  serializeVersion,
} from '@haverstack/wire-types';
import { APIAdapter } from '../src/index.js';
import { BASE_URL, DISCOVERY, OWNER, jsonResponse, mockFetch, useFetchMock } from './helpers.js';

useFetchMock();

const NOTE = 'com.example.test/note@1';
const create = (seed: StoreSeed) => MemoryAdapter.open({ seed });

/** A hosted stack holding a Type, Records and blobs, one blob named by no Record. */
async function hostedStack(): Promise<MemoryAdapter> {
  const store = await MemoryAdapter.open({ ownerEntityId: OWNER });
  const stack = await Stack.open(store);
  await stack.defineType({ id: NOTE, name: 'Note', schema: { text: { kind: 'text' } } });
  const note = await stack.create(NOTE, { text: 'first' });
  await stack.patchContent(note.id, { text: 'second' });
  await stack.putAttachment(new Uint8Array([1, 2, 3]), { mimeType: 'image/png' });
  await store.putBlob(new Uint8Array([9, 9]));
  return store;
}

/** Answer every request a copy makes from `store`, its head included. */
function serve(store: MemoryAdapter) {
  mockFetch.mockImplementation(async (input: string, init: RequestInit = {}) => {
    const url = new URL(input);
    const path = decodeURIComponent(url.pathname);
    const segments = path.split('/').filter(Boolean);
    if (path === '/.well-known/stack') {
      return jsonResponse({ ...DISCOVERY, blobs: { list: true }, head: { read: true } });
    }
    if (path === '/head') return jsonResponse({ head: await store.head() });
    if (path === '/records/query') {
      const page = await store.queryRecords(
        resolveQuery(parseQueryBody(JSON.parse(init.body as string))),
      );
      return jsonResponse({ records: page.records.map(serializeRecord), cursor: page.cursor });
    }
    if (segments[0] === 'records' && segments.length === 2) {
      const record = await store.getRecord(segments[1]);
      return record ? jsonResponse(serializeRecord(record)) : jsonResponse(undefined, 404);
    }
    if (segments[0] === 'records' && segments[2] === 'versions') {
      const versions = await store.getVersions(segments[1]);
      return jsonResponse({ versions: versions.map(serializeVersion), cursor: null });
    }
    if (segments[0] === 'records' && segments[2] === 'journal') {
      const entries = await store.getJournal(segments[1]);
      return jsonResponse({ entries: entries.map(serializeJournalEntry), cursor: null });
    }
    if (path === '/types') return jsonResponse((await store.listTypes()).map(serializeType));
    if (path === '/blobs') {
      const query = parseBlobsParams(url);
      const page = await store.listBlobs!(query);
      const full = query.limit !== undefined && page.length === query.limit;
      return jsonResponse({
        blobs: page.map(serializeBlobInfo),
        cursor: full ? page[page.length - 1].fileId : null,
      });
    }
    if (segments[0] === 'attachments') {
      const bytes = await store.getBlob(segments[1]);
      return new Response(new Uint8Array(bytes), {
        headers: { 'Content-Type': 'application/octet-stream' },
      });
    }
    throw new Error(`Unexpected request: ${init.method ?? 'GET'} ${path}`);
  });
}

const openHost = () => APIAdapter.open({ url: BASE_URL, token: 'owner-token' });

describe('a hosted stack copied out over the wire', () => {
  test('arrives whole: every Record with its history, every Type and every blob', async () => {
    const host = await hostedStack();
    serve(host);
    const target = (await copyStack(await openHost(), create)) as MemoryAdapter;

    expect([...target.records.keys()].sort()).toEqual([...host.records.keys()].sort());
    for (const id of host.records.keys()) {
      expect(await target.getRecord(id)).toEqual(await host.getRecord(id));
      expect(await target.getVersions(id)).toEqual(await host.getVersions(id));
      expect(await target.getJournal(id)).toEqual(await host.getJournal(id));
    }
    expect(await target.listTypes()).toEqual(await host.listTypes());
    // A blob's modifiedAt is when its own store wrote it, so bytes are compared instead.
    const held = await host.listBlobs!();
    expect((await target.listBlobs!()).map((b) => b.fileId)).toEqual(held.map((b) => b.fileId));
    for (const { fileId } of held) {
      expect(await target.getBlob(fileId)).toEqual(await host.getBlob(fileId));
    }
  });

  test('is refused when the host was written during the copy', async () => {
    const host = await hostedStack();
    serve(host);
    const meanwhile = async (seed: StoreSeed) => {
      await (await Stack.open(host)).create(NOTE, { text: 'a member, mid-copy' });
      return create(seed);
    };
    await expect(copyStack(await openHost(), meanwhile)).rejects.toThrow(StackConflictError);
  });

  // Each is refused locally, from discovery, before a request is spent on the copy.
  test.each([
    ['a blob listing', { head: { read: true } }],
    ['a head', { blobs: { list: true } }],
  ])('is refused before anything is read when discovery advertises no %s', async (_, adds) => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ ...DISCOVERY, ...adds }));
    const host = await openHost();
    await expect(copyStack(host, create)).rejects.toThrow(InvalidAdapterError);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});
