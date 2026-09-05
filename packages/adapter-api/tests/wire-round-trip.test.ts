import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { APIAdapter } from '../src/index.js';
import {
  parseQueryParams,
  parseQueryBody,
  parseChangeParams,
  createOptionsFromWireRecord,
} from '@haverstack/core/wire';
import type { WireCreateRequest } from '@haverstack/core/wire';
import { serializeRecord } from '@haverstack/wire-types';
import type { StackQuery, StackRecord, TokenSession } from '@haverstack/core';
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

// -------------------------------------------------------
// POST /records
// -------------------------------------------------------

/**
 * Create a record through the adapter and hand back what core's helper
 * makes of the body it sent. The record is a whole record, which is what a
 * create body is — including the fields the server assigns.
 */
async function roundTripCreate(
  record: StackRecord,
  session: TokenSession,
): Promise<WireCreateRequest> {
  mockFetch.mockResolvedValueOnce(jsonResponse(discovery(false)));
  const adapter = await APIAdapter.open({ url: BASE_URL, token: 'test-token' });

  mockFetch.mockResolvedValueOnce(jsonResponse(serializeRecord(record)));
  await adapter.createRecord(record);

  const [, init] = mockFetch.mock.calls[1] as [string, RequestInit];
  return createOptionsFromWireRecord(JSON.parse(init.body as string), session, OWNER);
}

const OWNER = 'did:key:zOwner';
const GRANTEE = 'did:key:zAlice';

const recordToCreate = (overrides: Partial<StackRecord> = {}): StackRecord => ({
  id: '0000000abcde',
  typeId: 'com.example/note@1',
  createdAt: new Date('2020-01-01T00:00:00.000Z'),
  updatedAt: new Date('2020-01-02T00:00:00.000Z'),
  content: { text: 'hello' },
  version: 1,
  ...overrides,
});

describe('POST /records round trip', () => {
  test('what the client sends is what the helper reads back', async () => {
    const record = recordToCreate({
      parentId: '0000000parnt',
      appId: 'com.example.editor',
      permissions: [{ access: 'public' }],
      associations: [{ kind: 'tag', label: 'starred' }],
    });
    const { typeId, content, options } = await roundTripCreate(record, {
      principalId: OWNER,
      subjectId: OWNER,
    });

    expect(typeId).toBe(record.typeId);
    expect(content).toEqual(record.content);
    expect(options.id).toBe(record.id);
    expect(options.parentId).toBe(record.parentId);
    expect(options.appId).toBe(record.appId);
    expect(options.permissions).toEqual(record.permissions);
    expect(options.associations).toEqual(record.associations);
    expect(options.createdAt).toEqual(record.createdAt);
    expect(options.updatedAt).toEqual(record.updatedAt);
  });

  // The client cannot avoid sending these — a record body is a whole
  // record, serialized whole — so this is the body every server actually
  // receives, not a hostile one.
  test('the identity fields the client serializes do not survive the trip', async () => {
    const { options } = await roundTripCreate(
      recordToCreate({ entityId: GRANTEE, principalId: 'did:key:zApp' }),
      { principalId: OWNER, subjectId: OWNER },
    );
    expect('entityId' in options).toBe(false);
    expect('principalId' in options).toBe(false);
  });

  test('an unlisted record travels as unlistedAt and arrives as unlisted', async () => {
    const { options } = await roundTripCreate(
      recordToCreate({ unlistedAt: new Date('2020-01-01T00:00:00.000Z') }),
      { principalId: GRANTEE, subjectId: GRANTEE },
    );
    expect(options.unlisted).toBe(true);
  });

  // The bug the helper exists to prevent: both clock fields are on every
  // body a client sends, and forwarding a grantee's would earn a 403.
  test('a grantee’s create arrives without the clock fields it could not use', async () => {
    const { options } = await roundTripCreate(recordToCreate(), {
      principalId: GRANTEE,
      subjectId: GRANTEE,
    });
    expect('createdAt' in options).toBe(false);
    expect('updatedAt' in options).toBe(false);
  });
});
