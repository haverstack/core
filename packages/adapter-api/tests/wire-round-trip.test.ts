import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { APIAdapter } from '../src/index.js';
import { parseQueryParams, parseQueryBody, parseChangeParams } from '@haverstack/core/wire';
import type { StackQuery } from '@haverstack/core';
import type { SubscribeChangesOptions } from '@haverstack/core/adapter';

/**
 * The request encoding, exercised as a round trip: a query goes out through
 * the real adapter, the URL or body it actually put on the wire is captured,
 * and core's parser decodes it back. What comes out must be what went in.
 *
 * This is the check the two halves living in one repository buys, and it
 * reaches what a fixture cannot: a fixture pins the shapes it happens to
 * carry, while this fails the moment a filter field the builder encodes and
 * the parser doesn't (or the reverse) appears.
 */

const BASE_URL = 'https://stack.example.com';

const capabilities = (contentFieldQuery: boolean) => ({
  fullTextSearch: true,
  contentFieldQuery,
  nestedContentQuery: true,
  sortableFields: ['createdAt', 'updatedAt', 'version'],
  maxAttachmentBytes: null,
  maxContentBytes: null,
});

const discovery = (contentFieldQuery: boolean) => ({
  version: '1.0',
  entityId: 'did:key:zOwner',
  capabilities: capabilities(contentFieldQuery),
  changes: { transports: ['sse'], resume: true, records: true },
});

const jsonResponse = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

const EMPTY_PAGE = { records: [], cursor: null, total: null };

let mockFetch: ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockFetch = vi.fn();
  vi.stubGlobal('fetch', mockFetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * Dispatch a query through the adapter and hand back what core's parser
 * makes of the request it sent. `contentFieldQuery` picks the branch:
 * false takes GET /records' search params, true takes POST /records/query's
 * JSON body.
 */
async function roundTrip(query: StackQuery, contentFieldQuery = false): Promise<StackQuery> {
  mockFetch.mockResolvedValueOnce(jsonResponse(discovery(contentFieldQuery)));
  const adapter = await APIAdapter.open({ url: BASE_URL, token: 'test-token' });

  mockFetch.mockResolvedValueOnce(jsonResponse(EMPTY_PAGE));
  await adapter.queryRecords(query);

  const [url, init] = mockFetch.mock.calls[1] as [string, RequestInit];
  return contentFieldQuery
    ? parseQueryBody(JSON.parse(init.body as string))
    : parseQueryParams(new URL(url));
}

/** The same, for GET /changes' params. */
async function roundTripChanges(
  opts: SubscribeChangesOptions,
): Promise<ReturnType<typeof parseChangeParams>> {
  mockFetch.mockResolvedValueOnce(jsonResponse(discovery(false)));
  const adapter = await APIAdapter.open({ url: BASE_URL, token: 'test-token' });

  // A stream carrying nothing but the `ready` the adapter waits on before
  // it resolves: the request the feed opens is what this captures, not
  // anything it goes on to carry.
  const encoder = new TextEncoder();
  mockFetch.mockResolvedValueOnce(
    new Response(
      new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(encoder.encode('event: ready\ndata: {"seq":"AA3f1Q"}\n\n'));
        },
      }),
      { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
    ),
  );
  const unsubscribe = await adapter.subscribeChanges(opts, () => {});
  unsubscribe();

  const [url] = mockFetch.mock.calls[1] as [string];
  return parseChangeParams(new URL(url));
}

// -------------------------------------------------------
// GET /records
// -------------------------------------------------------

describe('GET /records round trip', () => {
  const cases: Array<[string, StackQuery]> = [
    ['empty query', {}],
    ['single typeId', { filter: { typeId: 'com.example/note@1' } }],
    ['typeId array', { filter: { typeId: ['com.example/note@1', 'com.example/note@2'] } }],
    ['parentId', { filter: { parentId: 'rec-parent1' } }],
    ['root records', { filter: { parentId: null } }],
    ['single appId', { filter: { appId: 'com.example.app' } }],
    ['appId array', { filter: { appId: ['com.example.a', 'com.example.b'] } }],
    ['single entityId', { filter: { entityId: 'did:key:zAlice' } }],
    ['entityId array', { filter: { entityId: ['did:key:zAlice', 'did:key:zBob'] } }],
    ['single principalId', { filter: { principalId: 'did:key:zApp' } }],
    ['principalId array', { filter: { principalId: ['did:key:zApp', 'did:key:zOther'] } }],
    [
      'createdAt before',
      { filter: { createdAt: { before: new Date('2024-06-15T12:00:00.000Z') } } },
    ],
    ['createdAt after', { filter: { createdAt: { after: new Date('2024-01-01T00:00:00.000Z') } } }],
    [
      'createdAt both bounds',
      {
        filter: {
          createdAt: {
            before: new Date('2024-12-31T23:59:59.000Z'),
            after: new Date('2024-01-01T00:00:00.000Z'),
          },
        },
      },
    ],
    [
      'updatedAt before',
      { filter: { updatedAt: { before: new Date('2024-06-15T12:00:00.000Z') } } },
    ],
    ['updatedAt after', { filter: { updatedAt: { after: new Date('2024-01-01T00:00:00.000Z') } } }],
    ['tags', { filter: { tags: ['starred', 'important'] } }],
    ['hasAttachment', { filter: { hasAttachment: 'cover' } }],
    ['attachmentFileId', { filter: { attachmentFileId: 'file-abc123' } }],
    ['search', { filter: { search: 'quarterly report' } }],
    ['includeDeleted', { filter: { includeDeleted: true } }],
    ['includeUnlisted', { filter: { includeUnlisted: true } }],
    ['relatedTo label alone', { filter: { relatedTo: { label: 'attachment' } } }],
    [
      'relatedTo record scope',
      { filter: { relatedTo: { target: { scope: 'record', recordId: 'rec-target1' } } } },
    ],
    [
      'relatedTo record scope with stackUrl',
      {
        filter: {
          relatedTo: {
            target: {
              scope: 'record',
              recordId: 'rec-target1',
              stackUrl: 'https://other.example.com',
            },
          },
        },
      },
    ],
    [
      'relatedTo entity scope',
      { filter: { relatedTo: { target: { scope: 'entity', entityId: 'did:key:zCarol' } } } },
    ],
    [
      'relatedTo external scope, whole namespace',
      { filter: { relatedTo: { target: { scope: 'external', ns: 'isbn' } } } },
    ],
    [
      'relatedTo external scope with id',
      { filter: { relatedTo: { target: { scope: 'external', ns: 'isbn', id: '9780123456789' } } } },
    ],
    [
      'relatedTo label and target together',
      {
        filter: {
          relatedTo: { label: 'cites', target: { scope: 'entity', entityId: 'did:key:zCarol' } },
        },
      },
    ],
    ['sort field', { sort: { field: 'createdAt' } }],
    ['sort with direction', { sort: { field: 'updatedAt', direction: 'desc' } }],
    ['limit', { limit: 50 }],
    ['cursor', { cursor: 'opaque-cursor-value' }],
    [
      'every native field at once',
      {
        filter: {
          typeId: ['com.example/note@1', 'com.example/note@2'],
          parentId: 'rec-parent1',
          appId: 'com.example.app',
          entityId: 'did:key:zAlice',
          principalId: 'did:key:zApp',
          createdAt: { after: new Date('2024-01-01T00:00:00.000Z') },
          updatedAt: { before: new Date('2024-12-31T00:00:00.000Z') },
          tags: ['starred'],
          hasAttachment: 'cover',
          attachmentFileId: 'file-abc123',
          relatedTo: { label: 'cites', target: { scope: 'external', ns: 'isbn', id: '978' } },
          search: 'report',
          includeDeleted: true,
          includeUnlisted: true,
        },
        sort: { field: 'version', direction: 'asc' },
        limit: 25,
        cursor: 'page-2',
      },
    ],
  ];

  test.each(cases)('%s survives the round trip', async (_name, query) => {
    expect(await roundTrip(query)).toEqual(query);
  });
});

// -------------------------------------------------------
// POST /records/query
// -------------------------------------------------------

describe('POST /records/query round trip', () => {
  const cases: Array<[string, StackQuery]> = [
    ['empty query', {}],
    ['native fields', { filter: { typeId: 'com.example/note@1', tags: ['starred'] } }],
    ['root records', { filter: { parentId: null } }],
    ['dates', { filter: { createdAt: { after: new Date('2024-01-01T00:00:00.000Z') } } }],
    ['single-segment content filter', { filter: { content: { status: 'open' } } }],
    ['nested content filter', { filter: { content: { 'emails.value': 'a@example.com' } } }],
    [
      'relatedTo external scope with id',
      { filter: { relatedTo: { target: { scope: 'external', ns: 'isbn', id: '978' } } } },
    ],
    [
      'sort, limit and cursor',
      { sort: { field: 'createdAt', direction: 'desc' }, limit: 10, cursor: 'c' },
    ],
  ];

  test.each(cases)('%s survives the round trip', async (_name, query) => {
    expect(await roundTrip(query, true)).toEqual(query);
  });

  // filter.content has no URL-param encoding on either side, by design:
  // the two endpoints are genuinely different surfaces rather than one
  // function with a flag. See docs/spec/wire-format.md § Records.
  test('content filters reach only the POST body', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(discovery(true)));
    const adapter = await APIAdapter.open({ url: BASE_URL, token: 'test-token' });
    mockFetch.mockResolvedValueOnce(jsonResponse(EMPTY_PAGE));
    await adapter.queryRecords({ filter: { content: { status: 'open' } } });

    const [url, init] = mockFetch.mock.calls[1] as [string, RequestInit];
    expect(url).toBe(`${BASE_URL}/records/query`);
    expect(init.method).toBe('POST');
  });
});

// -------------------------------------------------------
// GET /changes
// -------------------------------------------------------

describe('GET /changes round trip', () => {
  const cases: Array<[string, SubscribeChangesOptions]> = [
    ['no options', {}],
    ['single typeId', { filter: { typeId: 'com.example/note@1' } }],
    ['typeId array', { filter: { typeId: ['com.example/note@1', 'com.example/note@2'] } }],
    ['parentId', { filter: { parentId: 'rec-parent1' } }],
    ['root records', { filter: { parentId: null } }],
    ['entityId', { filter: { entityId: 'did:key:zAlice' } }],
    ['kinds', { filter: { kinds: ['created', 'deleted'] } }],
    ['includeRecords', { includeRecords: true }],
    ['includeUnlisted', { includeUnlisted: true }],
    [
      'everything at once',
      {
        filter: {
          typeId: 'com.example/note@1',
          parentId: null,
          entityId: 'did:key:zAlice',
          kinds: ['created', 'changed', 'deleted', 'purged'],
        },
        includeRecords: true,
        includeUnlisted: true,
      },
    ],
  ];

  test.each(cases)('%s survives the round trip', async (_name, opts) => {
    expect(await roundTripChanges(opts)).toEqual({
      filter: opts.filter ?? {},
      includeRecords: opts.includeRecords ?? false,
      includeUnlisted: opts.includeUnlisted ?? false,
    });
  });
});
