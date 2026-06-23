import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  APIAdapter,
  APIAdapterAuthError,
  APIAdapterConnectionError,
  APIAdapterError,
} from '../src/index.js';
import type { StackRecord, StackType, RecordVersion, Association } from '@haverstack/core';

// -------------------------------------------------------
// Test fixtures
// -------------------------------------------------------

const BASE_URL = 'https://stack.example.com';
const TOKEN = 'test-token-abc';

const DISCOVERY = {
  version: '1.0',
  entityId: 'entity-owner-123',
  timezone: 'America/New_York',
  capabilities: {
    fullTextSearch: true,
    contentFieldQuery: true,
    sortableFields: ['createdAt', 'updatedAt', 'version'],
  },
};

const RECORD_RAW = {
  id: 'rec-abc123',
  typeId: 'com.example/note@1',
  createdAt: '2024-06-15T12:00:00.000Z',
  updatedAt: '2024-06-15T12:00:00.000Z',
  content: { text: 'Hello world' },
  version: 1,
};

const NOTE_TYPE_RAW = {
  id: 'com.example/note@1',
  baseId: 'com.example/note',
  version: 1,
  name: 'Note',
  schema: { text: { kind: 'text', required: true } },
  schemaHash: 'abc123hash',
  createdAt: '2024-01-01T00:00:00.000Z',
};

const VERSION_RAW = {
  version: 1,
  content: { text: 'original' },
  updatedAt: '2024-01-01T00:00:00.000Z',
  entityId: 'entity-owner-123',
};

// -------------------------------------------------------
// Mock helpers
// -------------------------------------------------------

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const noContent = (): Response => new Response(null, { status: 204 });

let mockFetch: ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockFetch = vi.fn();
  vi.stubGlobal('fetch', mockFetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Open an adapter — consumes the first fetch call for discovery. */
const openAdapter = async (discoveryOverride?: object): Promise<APIAdapter> => {
  mockFetch.mockResolvedValueOnce(jsonResponse(discoveryOverride ?? DISCOVERY));
  return APIAdapter.open({ url: BASE_URL, token: TOKEN });
};

// -------------------------------------------------------
// open()
// -------------------------------------------------------

describe('open', () => {
  test('calls GET /.well-known/stack', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(DISCOVERY));
    await APIAdapter.open({ url: BASE_URL, token: TOKEN });
    expect(mockFetch).toHaveBeenCalledWith(
      `${BASE_URL}/.well-known/stack`,
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: `Bearer ${TOKEN}` }),
      }),
    );
  });

  test('strips trailing slash from url', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(DISCOVERY));
    await APIAdapter.open({ url: `${BASE_URL}/`, token: TOKEN });
    expect(mockFetch).toHaveBeenCalledWith(`${BASE_URL}/.well-known/stack`, expect.anything());
  });

  test('populates capabilities from discovery response', async () => {
    const adapter = await openAdapter();
    expect(adapter.capabilities.fullTextSearch).toBe(true);
    expect(adapter.capabilities.contentFieldQuery).toBe(true);
    expect(adapter.capabilities.sortableFields).toEqual(['createdAt', 'updatedAt', 'version']);
  });

  test('populates ownerEntityId from discovery response', async () => {
    const adapter = await openAdapter();
    expect(adapter.ownerEntityId).toBe('entity-owner-123');
  });

  test('populates timezone from discovery response', async () => {
    const adapter = await openAdapter();
    expect(adapter.timezone).toBe('America/New_York');
  });

  test('defaults timezone to UTC when not in discovery response', async () => {
    const adapter = await openAdapter({ ...DISCOVERY, timezone: undefined });
    expect(adapter.timezone).toBe('UTC');
  });

  test('omits Authorization header when no token provided', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(DISCOVERY));
    await APIAdapter.open({ url: BASE_URL });
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)['Authorization']).toBeUndefined();
  });

  test('throws APIAdapterAuthError on 401', async () => {
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 401 }));
    await expect(APIAdapter.open({ url: BASE_URL, token: 'bad-token' })).rejects.toThrow(
      APIAdapterAuthError,
    );
  });

  test('throws APIAdapterConnectionError when fetch rejects', async () => {
    mockFetch.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await expect(APIAdapter.open({ url: BASE_URL, token: TOKEN })).rejects.toThrow(
      APIAdapterConnectionError,
    );
  });

  test('throws APIAdapterError on non-401 error status', async () => {
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 503 }));
    await expect(APIAdapter.open({ url: BASE_URL, token: TOKEN })).rejects.toThrow(APIAdapterError);
  });
});

// -------------------------------------------------------
// createRecord
// -------------------------------------------------------

describe('createRecord', () => {
  test('sends POST /records with record body', async () => {
    const adapter = await openAdapter();
    mockFetch.mockResolvedValueOnce(jsonResponse(RECORD_RAW));

    const record: StackRecord = {
      id: 'rec-abc123',
      typeId: 'com.example/note@1',
      createdAt: new Date('2024-06-15T12:00:00.000Z'),
      updatedAt: new Date('2024-06-15T12:00:00.000Z'),
      content: { text: 'Hello world' },
      version: 1,
    };
    await adapter.createRecord(record);

    expect(mockFetch).toHaveBeenLastCalledWith(
      `${BASE_URL}/records`,
      expect.objectContaining({ method: 'POST' }),
    );
  });

  test('parses dates in response', async () => {
    const adapter = await openAdapter();
    mockFetch.mockResolvedValueOnce(jsonResponse(RECORD_RAW));

    const record: StackRecord = {
      id: 'rec-abc123',
      typeId: 'com.example/note@1',
      createdAt: new Date(),
      updatedAt: new Date(),
      content: { text: 'Hello' },
      version: 1,
    };
    const result = await adapter.createRecord(record);
    expect(result.createdAt).toBeInstanceOf(Date);
    expect(result.updatedAt).toBeInstanceOf(Date);
    expect(result.createdAt.toISOString()).toBe('2024-06-15T12:00:00.000Z');
  });

  test('sends Authorization header', async () => {
    const adapter = await openAdapter();
    mockFetch.mockResolvedValueOnce(jsonResponse(RECORD_RAW));
    const record: StackRecord = {
      id: 'r1',
      typeId: 'com.example/note@1',
      createdAt: new Date(),
      updatedAt: new Date(),
      content: {},
      version: 1,
    };
    await adapter.createRecord(record);
    const [, init] = mockFetch.mock.lastCall as [string, RequestInit];
    expect((init.headers as Record<string, string>)['Authorization']).toBe(`Bearer ${TOKEN}`);
  });
});

// -------------------------------------------------------
// getRecord
// -------------------------------------------------------

describe('getRecord', () => {
  test('sends GET /records/:id', async () => {
    const adapter = await openAdapter();
    mockFetch.mockResolvedValueOnce(jsonResponse(RECORD_RAW));
    await adapter.getRecord('rec-abc123');
    expect(mockFetch).toHaveBeenLastCalledWith(
      `${BASE_URL}/records/rec-abc123`,
      expect.objectContaining({ method: 'GET' }),
    );
  });

  test('parses response into StackRecord with Date objects', async () => {
    const adapter = await openAdapter();
    mockFetch.mockResolvedValueOnce(jsonResponse(RECORD_RAW));
    const result = await adapter.getRecord('rec-abc123');
    expect(result).not.toBeNull();
    expect(result!.id).toBe('rec-abc123');
    expect(result!.createdAt).toBeInstanceOf(Date);
  });

  test('returns null on 404', async () => {
    const adapter = await openAdapter();
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 404 }));
    expect(await adapter.getRecord('nonexistent')).toBeNull();
  });

  test('parses optional fields when present', async () => {
    const adapter = await openAdapter();
    const withOptionals = {
      ...RECORD_RAW,
      parentId: 'parent-1',
      entityId: 'entity-1',
      appId: 'app-1',
      deletedAt: '2024-06-16T00:00:00.000Z',
      permissions: [{ access: 'public' }],
      associations: [{ kind: 'tag', label: 'starred' }],
    };
    mockFetch.mockResolvedValueOnce(jsonResponse(withOptionals));
    const result = await adapter.getRecord('rec-abc123');
    expect(result!.parentId).toBe('parent-1');
    expect(result!.entityId).toBe('entity-1');
    expect(result!.appId).toBe('app-1');
    expect(result!.deletedAt).toBeInstanceOf(Date);
    expect(result!.permissions).toEqual([{ access: 'public' }]);
    expect(result!.associations).toEqual([{ kind: 'tag', label: 'starred' }]);
  });
});

// -------------------------------------------------------
// updateRecord
// -------------------------------------------------------

describe('updateRecord', () => {
  test('sends PATCH /records/:id', async () => {
    const adapter = await openAdapter();
    const updated = { ...RECORD_RAW, content: { text: 'Updated' }, version: 2 };
    mockFetch.mockResolvedValueOnce(jsonResponse(updated));
    await adapter.updateRecord('rec-abc123', { content: { text: 'Updated' }, version: 2 });
    expect(mockFetch).toHaveBeenLastCalledWith(
      `${BASE_URL}/records/rec-abc123`,
      expect.objectContaining({ method: 'PATCH' }),
    );
  });

  test('returns updated record with parsed dates', async () => {
    const adapter = await openAdapter();
    const updated = { ...RECORD_RAW, content: { text: 'Updated' }, version: 2 };
    mockFetch.mockResolvedValueOnce(jsonResponse(updated));
    const result = await adapter.updateRecord('rec-abc123', { content: { text: 'Updated' } });
    expect(result.content).toEqual({ text: 'Updated' });
    expect(result.updatedAt).toBeInstanceOf(Date);
  });
});

// -------------------------------------------------------
// deleteRecord
// -------------------------------------------------------

describe('deleteRecord', () => {
  test('sends DELETE /records/:id for soft delete', async () => {
    const adapter = await openAdapter();
    mockFetch.mockResolvedValueOnce(noContent());
    await adapter.deleteRecord('rec-abc123');
    expect(mockFetch).toHaveBeenLastCalledWith(
      `${BASE_URL}/records/rec-abc123`,
      expect.objectContaining({ method: 'DELETE' }),
    );
  });

  test('appends ?hard=true for hard delete', async () => {
    const adapter = await openAdapter();
    mockFetch.mockResolvedValueOnce(noContent());
    await adapter.deleteRecord('rec-abc123', { hard: true });
    expect(mockFetch).toHaveBeenLastCalledWith(
      `${BASE_URL}/records/rec-abc123?hard=true`,
      expect.objectContaining({ method: 'DELETE' }),
    );
  });
});

// -------------------------------------------------------
// queryRecords
// -------------------------------------------------------

describe('queryRecords', () => {
  const queryEnvelope = {
    records: [RECORD_RAW],
    cursor: null,
    total: 1,
  };

  test('uses POST /records/query when contentFieldQuery is true', async () => {
    const adapter = await openAdapter();
    mockFetch.mockResolvedValueOnce(jsonResponse(queryEnvelope));
    await adapter.queryRecords({ filter: { typeId: 'com.example/note@1' } });
    expect(mockFetch).toHaveBeenLastCalledWith(
      `${BASE_URL}/records/query`,
      expect.objectContaining({ method: 'POST' }),
    );
  });

  test('uses GET /records when contentFieldQuery is false', async () => {
    const limitedDiscovery = {
      ...DISCOVERY,
      capabilities: { ...DISCOVERY.capabilities, contentFieldQuery: false },
    };
    const adapter = await openAdapter(limitedDiscovery);
    mockFetch.mockResolvedValueOnce(jsonResponse(queryEnvelope));
    await adapter.queryRecords({ filter: { typeId: 'com.example/note@1' } });
    const [url, init] = mockFetch.mock.lastCall as [string, RequestInit];
    expect(init.method).toBe('GET');
    expect(url).toContain('/records');
    expect(url).toContain('typeId=com.example%2Fnote%401');
  });

  test('parses records and cursor from response', async () => {
    const adapter = await openAdapter();
    mockFetch.mockResolvedValueOnce(jsonResponse({ ...queryEnvelope, cursor: 'page2', total: 10 }));
    const result = await adapter.queryRecords({});
    expect(result.records).toHaveLength(1);
    expect(result.records[0].createdAt).toBeInstanceOf(Date);
    expect(result.cursor).toBe('page2');
    expect(result.total).toBe(10);
  });

  test('passes query body to POST /records/query', async () => {
    const adapter = await openAdapter();
    mockFetch.mockResolvedValueOnce(jsonResponse(queryEnvelope));
    const query = { filter: { typeId: 'com.example/note@1' }, limit: 10 };
    await adapter.queryRecords(query);
    const [, init] = mockFetch.mock.lastCall as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual(query);
  });

  test('builds correct GET params — parentId null becomes "null"', async () => {
    const limitedDiscovery = {
      ...DISCOVERY,
      capabilities: { ...DISCOVERY.capabilities, contentFieldQuery: false },
    };
    const adapter = await openAdapter(limitedDiscovery);
    mockFetch.mockResolvedValueOnce(jsonResponse(queryEnvelope));
    await adapter.queryRecords({ filter: { parentId: null } });
    const [url] = mockFetch.mock.lastCall as [string];
    expect(url).toContain('parentId=null');
  });
});

// -------------------------------------------------------
// associate / dissociate
// -------------------------------------------------------

describe('associate', () => {
  test('sends POST /records/:id/associations', async () => {
    const adapter = await openAdapter();
    mockFetch.mockResolvedValueOnce(noContent());
    const assoc: Association = { kind: 'tag', label: 'starred' };
    await adapter.associate('rec-abc123', assoc);
    expect(mockFetch).toHaveBeenLastCalledWith(
      `${BASE_URL}/records/rec-abc123/associations`,
      expect.objectContaining({ method: 'POST' }),
    );
  });

  test('sends the association as JSON body', async () => {
    const adapter = await openAdapter();
    mockFetch.mockResolvedValueOnce(noContent());
    const assoc: Association = { kind: 'tag', label: 'starred' };
    await adapter.associate('rec-abc123', assoc);
    const [, init] = mockFetch.mock.lastCall as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual(assoc);
  });
});

describe('dissociate', () => {
  test('sends DELETE /records/:id/associations', async () => {
    const adapter = await openAdapter();
    mockFetch.mockResolvedValueOnce(noContent());
    const assoc: Association = { kind: 'tag', label: 'starred' };
    await adapter.dissociate('rec-abc123', assoc);
    expect(mockFetch).toHaveBeenLastCalledWith(
      `${BASE_URL}/records/rec-abc123/associations`,
      expect.objectContaining({ method: 'DELETE' }),
    );
  });
});

// -------------------------------------------------------
// Versions
// -------------------------------------------------------

describe('getVersions', () => {
  test('sends GET /records/:id/versions', async () => {
    const adapter = await openAdapter();
    mockFetch.mockResolvedValueOnce(jsonResponse([VERSION_RAW]));
    await adapter.getVersions('rec-abc123');
    expect(mockFetch).toHaveBeenLastCalledWith(
      `${BASE_URL}/records/rec-abc123/versions`,
      expect.objectContaining({ method: 'GET' }),
    );
  });

  test('parses version array with Date objects', async () => {
    const adapter = await openAdapter();
    mockFetch.mockResolvedValueOnce(jsonResponse([VERSION_RAW]));
    const versions = await adapter.getVersions('rec-abc123');
    expect(versions).toHaveLength(1);
    expect(versions[0].version).toBe(1);
    expect(versions[0].updatedAt).toBeInstanceOf(Date);
    expect(versions[0].entityId).toBe('entity-owner-123');
  });
});

describe('getVersion', () => {
  test('sends GET /records/:id/versions/:version', async () => {
    const adapter = await openAdapter();
    mockFetch.mockResolvedValueOnce(jsonResponse(VERSION_RAW));
    await adapter.getVersion('rec-abc123', 1);
    expect(mockFetch).toHaveBeenLastCalledWith(
      `${BASE_URL}/records/rec-abc123/versions/1`,
      expect.objectContaining({ method: 'GET' }),
    );
  });

  test('returns null on 404', async () => {
    const adapter = await openAdapter();
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 404 }));
    expect(await adapter.getVersion('rec-abc123', 99)).toBeNull();
  });
});

describe('saveVersion', () => {
  test('is a no-op — does not make any HTTP requests', async () => {
    const adapter = await openAdapter();
    const callsBefore = mockFetch.mock.calls.length;
    const v: RecordVersion = { version: 1, content: { text: 'v1' }, updatedAt: new Date() };
    await expect(adapter.saveVersion('rec-abc123', v)).resolves.toBeUndefined();
    expect(mockFetch.mock.calls.length).toBe(callsBefore);
  });
});

// -------------------------------------------------------
// Types
// -------------------------------------------------------

describe('saveType', () => {
  test('sends POST /types with type body', async () => {
    const adapter = await openAdapter();
    mockFetch.mockResolvedValueOnce(noContent());
    const type: StackType = {
      id: 'com.example/note@1',
      baseId: 'com.example/note',
      version: 1,
      name: 'Note',
      schema: { text: { kind: 'text', required: true } },
      schemaHash: 'abc123',
      createdAt: new Date(),
    };
    await adapter.saveType(type);
    expect(mockFetch).toHaveBeenLastCalledWith(
      `${BASE_URL}/types`,
      expect.objectContaining({ method: 'POST' }),
    );
  });
});

describe('getType', () => {
  test('sends GET /types/:id with URL-encoded id', async () => {
    const adapter = await openAdapter();
    mockFetch.mockResolvedValueOnce(jsonResponse(NOTE_TYPE_RAW));
    await adapter.getType('com.example/note@1');
    expect(mockFetch).toHaveBeenLastCalledWith(
      `${BASE_URL}/types/com.example%2Fnote%401`,
      expect.objectContaining({ method: 'GET' }),
    );
  });

  test('parses response into StackType with Date', async () => {
    const adapter = await openAdapter();
    mockFetch.mockResolvedValueOnce(jsonResponse(NOTE_TYPE_RAW));
    const type = await adapter.getType('com.example/note@1');
    expect(type).not.toBeNull();
    expect(type!.id).toBe('com.example/note@1');
    expect(type!.createdAt).toBeInstanceOf(Date);
    expect(type!.schema).toEqual({ text: { kind: 'text', required: true } });
  });

  test('returns null on 404', async () => {
    const adapter = await openAdapter();
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 404 }));
    expect(await adapter.getType('com.example/unknown@1')).toBeNull();
  });

  test('parses migratesFrom when present', async () => {
    const adapter = await openAdapter();
    const withLineage = { ...NOTE_TYPE_RAW, migratesFrom: 'com.example/note@0' };
    mockFetch.mockResolvedValueOnce(jsonResponse(withLineage));
    const type = await adapter.getType('com.example/note@1');
    expect(type!.migratesFrom).toBe('com.example/note@0');
  });
});

describe('listTypes', () => {
  test('sends GET /types', async () => {
    const adapter = await openAdapter();
    mockFetch.mockResolvedValueOnce(jsonResponse([NOTE_TYPE_RAW]));
    const types = await adapter.listTypes();
    expect(mockFetch).toHaveBeenLastCalledWith(
      `${BASE_URL}/types`,
      expect.objectContaining({ method: 'GET' }),
    );
    expect(types).toHaveLength(1);
    expect(types[0].createdAt).toBeInstanceOf(Date);
  });
});

// -------------------------------------------------------
// Attachments
// -------------------------------------------------------

describe('putAttachment', () => {
  test('sends POST /attachments with binary body and Content-Type: application/octet-stream', async () => {
    const adapter = await openAdapter();
    mockFetch.mockResolvedValueOnce(jsonResponse({ fileId: 'file-xyz' }));
    const data = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const fileId = await adapter.putAttachment(data);
    expect(fileId).toBe('file-xyz');
    const [url, init] = mockFetch.mock.lastCall as [string, RequestInit];
    expect(url).toBe(`${BASE_URL}/attachments`);
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe(
      'application/octet-stream',
    );
  });
});

describe('getAttachment', () => {
  test('sends GET /attachments/:fileId and returns Uint8Array', async () => {
    const adapter = await openAdapter();
    const data = new Uint8Array([1, 2, 3, 4]);
    mockFetch.mockResolvedValueOnce(new Response(data, { status: 200 }));
    const result = await adapter.getAttachment('file-xyz');
    expect(result).toBeInstanceOf(Uint8Array);
    expect(mockFetch).toHaveBeenLastCalledWith(
      `${BASE_URL}/attachments/file-xyz`,
      expect.anything(),
    );
  });
});

describe('deleteAttachment', () => {
  test('sends DELETE /attachments/:fileId', async () => {
    const adapter = await openAdapter();
    mockFetch.mockResolvedValueOnce(noContent());
    await adapter.deleteAttachment('file-xyz');
    expect(mockFetch).toHaveBeenLastCalledWith(
      `${BASE_URL}/attachments/file-xyz`,
      expect.objectContaining({ method: 'DELETE' }),
    );
  });
});

// -------------------------------------------------------
// Lifecycle
// -------------------------------------------------------

describe('flush', () => {
  test('is a no-op', async () => {
    const adapter = await openAdapter();
    const callsBefore = mockFetch.mock.calls.length;
    await expect(adapter.flush()).resolves.toBeUndefined();
    expect(mockFetch.mock.calls.length).toBe(callsBefore);
  });
});

describe('close', () => {
  test('is a no-op', async () => {
    const adapter = await openAdapter();
    const callsBefore = mockFetch.mock.calls.length;
    await expect(adapter.close()).resolves.toBeUndefined();
    expect(mockFetch.mock.calls.length).toBe(callsBefore);
  });
});

// -------------------------------------------------------
// Error propagation
// -------------------------------------------------------

describe('error propagation on subsequent requests', () => {
  test('throws APIAdapterAuthError on 401 during getRecord', async () => {
    const adapter = await openAdapter();
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 401 }));
    await expect(adapter.getRecord('rec-abc')).rejects.toThrow(APIAdapterAuthError);
  });

  test('throws APIAdapterConnectionError when network fails on createRecord', async () => {
    const adapter = await openAdapter();
    mockFetch.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const record: StackRecord = {
      id: 'r1',
      typeId: 'com.example/note@1',
      createdAt: new Date(),
      updatedAt: new Date(),
      content: {},
      version: 1,
    };
    await expect(adapter.createRecord(record)).rejects.toThrow(APIAdapterConnectionError);
  });

  test('throws APIAdapterError on 500', async () => {
    const adapter = await openAdapter();
    mockFetch.mockResolvedValueOnce(new Response('Internal Server Error', { status: 500 }));
    await expect(adapter.listTypes()).rejects.toThrow(APIAdapterError);
  });
});
