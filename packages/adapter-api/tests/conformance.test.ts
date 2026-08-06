/**
 * Drives APIAdapter through the shared wire-protocol fixtures from
 * @haverstack/conformance-fixtures, asserting it produces the documented
 * request for each fixture and parses the documented response. The same
 * fixtures are importable by a server implementation to assert the mirror
 * image: that its HTTP handlers accept the documented request and produce
 * the documented response. See that package for the fixture data itself.
 */
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { APIAdapter } from '../src/index.js';
import {
  createRecordFixtures,
  patchContentFixtures,
  deleteRecordFixtures,
  undeleteRecordFixtures,
  associateFixtures,
  dissociateFixtures,
  setPermissionsFixtures,
  restoreVersionFixtures,
  commitMigrationFixtures,
  errorResponseFixtures,
  attachmentUploadFixtures,
} from '@haverstack/conformance-fixtures';
import type { Association } from '@haverstack/core';
import {
  StackPermissionError,
  StackNotFoundError,
  StackConflictError,
  StackValidationError,
  StackQueryError,
} from '@haverstack/core';

const BASE_URL = 'https://stack.example.com';

const DISCOVERY = {
  version: '1.0',
  entityId: 'entity-owner-123',
  timezone: 'UTC',
  capabilities: {
    fullTextSearch: true,
    contentFieldQuery: true,
    sortableFields: ['createdAt', 'updatedAt', 'version'],
    maxAttachmentBytes: 52428800,
  },
};

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

let mockFetch: ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockFetch = vi.fn();
  vi.stubGlobal('fetch', mockFetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const openAdapter = async (): Promise<APIAdapter> => {
  mockFetch.mockResolvedValueOnce(jsonResponse(DISCOVERY));
  return APIAdapter.open({ url: BASE_URL });
};

/** Record id embedded in a fixture path like "/records/rec-1" or ".../rec-1/permissions". */
const idFromPath = (path: string): string => path.split('/')[2].split('?')[0];

describe('createRecord fixtures', () => {
  for (const fixture of createRecordFixtures) {
    test(fixture.name, async () => {
      const adapter = await openAdapter();
      mockFetch.mockResolvedValueOnce(jsonResponse(fixture.responseBody, fixture.responseStatus));

      const { createdAt, updatedAt, deletedAt, ...req } = fixture.requestBody!;
      await adapter.createRecord({
        ...req,
        createdAt: new Date(createdAt),
        updatedAt: new Date(updatedAt),
        ...(deletedAt !== undefined && { deletedAt: new Date(deletedAt) }),
      });

      const [url, init] = mockFetch.mock.lastCall as [string, RequestInit];
      expect(url).toBe(`${BASE_URL}${fixture.path}`);
      expect(init.method).toBe(fixture.method);
      expect(JSON.parse(init.body as string)).toEqual(fixture.requestBody);
    });
  }
});

describe('patchContent fixtures', () => {
  for (const fixture of patchContentFixtures) {
    test(fixture.name, async () => {
      const adapter = await openAdapter();
      mockFetch.mockResolvedValueOnce(jsonResponse(fixture.responseBody, fixture.responseStatus));

      const result = await adapter.patchContent(idFromPath(fixture.path), fixture.requestBody!);

      const [url, init] = mockFetch.mock.lastCall as [string, RequestInit];
      expect(url).toBe(`${BASE_URL}${fixture.path}`);
      expect(init.method).toBe(fixture.method);
      // The wire body is the raw patch only — never typeId, version, or updatedAt.
      expect(JSON.parse(init.body as string)).toEqual(fixture.requestBody);
      expect(result.content).toEqual(fixture.responseBody!.content);
      expect(result.version).toBe(fixture.responseBody!.version);
    });
  }
});

describe('deleteRecord fixtures', () => {
  for (const fixture of deleteRecordFixtures) {
    test(fixture.name, async () => {
      const adapter = await openAdapter();
      mockFetch.mockResolvedValueOnce(new Response(null, { status: fixture.responseStatus }));

      const hard = fixture.path.includes('hard=true');
      await adapter.deleteRecord(idFromPath(fixture.path), { hard });

      const [url, init] = mockFetch.mock.lastCall as [string, RequestInit];
      expect(url).toBe(`${BASE_URL}${fixture.path}`);
      expect(init.method).toBe(fixture.method);
    });
  }
});

describe('undeleteRecord fixtures', () => {
  for (const fixture of undeleteRecordFixtures) {
    test(fixture.name, async () => {
      const adapter = await openAdapter();
      mockFetch.mockResolvedValueOnce(jsonResponse(fixture.responseBody, fixture.responseStatus));

      const result = await adapter.undeleteRecord(idFromPath(fixture.path));

      const [url, init] = mockFetch.mock.lastCall as [string, RequestInit];
      expect(url).toBe(`${BASE_URL}${fixture.path}`);
      expect(init.method).toBe(fixture.method);
      expect(result.deletedAt).toBeUndefined();
    });
  }
});

describe('associate fixtures', () => {
  for (const fixture of associateFixtures) {
    test(fixture.name, async () => {
      const adapter = await openAdapter();
      mockFetch.mockResolvedValueOnce(new Response(null, { status: fixture.responseStatus }));

      await adapter.associate(idFromPath(fixture.path), fixture.requestBody as Association);

      const [url, init] = mockFetch.mock.lastCall as [string, RequestInit];
      expect(url).toBe(`${BASE_URL}${fixture.path}`);
      expect(init.method).toBe(fixture.method);
      expect(JSON.parse(init.body as string)).toEqual(fixture.requestBody);
    });
  }
});

describe('dissociate fixtures', () => {
  for (const fixture of dissociateFixtures) {
    test(fixture.name, async () => {
      const adapter = await openAdapter();
      mockFetch.mockResolvedValueOnce(new Response(null, { status: fixture.responseStatus }));

      await adapter.dissociate(idFromPath(fixture.path), fixture.requestBody as Association);

      const [url, init] = mockFetch.mock.lastCall as [string, RequestInit];
      expect(url).toBe(`${BASE_URL}${fixture.path}`);
      expect(init.method).toBe(fixture.method);
      expect(JSON.parse(init.body as string)).toEqual(fixture.requestBody);
    });
  }
});

describe('setPermissions fixtures', () => {
  for (const fixture of setPermissionsFixtures) {
    test(fixture.name, async () => {
      const adapter = await openAdapter();
      mockFetch.mockResolvedValueOnce(new Response(null, { status: fixture.responseStatus }));

      await adapter.setPermissions(
        idFromPath(fixture.path),
        fixture.requestBody!.permissions as never,
      );

      const [url, init] = mockFetch.mock.lastCall as [string, RequestInit];
      expect(url).toBe(`${BASE_URL}${fixture.path}`);
      expect(init.method).toBe(fixture.method);
      expect(JSON.parse(init.body as string)).toEqual(fixture.requestBody);
    });
  }
});

describe('restoreVersion fixtures', () => {
  for (const fixture of restoreVersionFixtures) {
    test(fixture.name, async () => {
      const adapter = await openAdapter();
      mockFetch.mockResolvedValueOnce(jsonResponse(fixture.responseBody, fixture.responseStatus));

      const version = Number(fixture.path.split('/').pop());
      const result = await adapter.restoreVersion(idFromPath(fixture.path), version);

      const [url, init] = mockFetch.mock.lastCall as [string, RequestInit];
      expect(url).toBe(`${BASE_URL}${fixture.path}`);
      expect(init.method).toBe(fixture.method);
      expect(result.content).toEqual(fixture.responseBody!.content);
    });
  }
});

describe('commitMigration fixtures', () => {
  for (const fixture of commitMigrationFixtures) {
    test(fixture.name, async () => {
      const adapter = await openAdapter();
      mockFetch.mockResolvedValueOnce(jsonResponse(fixture.responseBody, fixture.responseStatus));

      const { toTypeId, content } = fixture.requestBody!;
      const result = await adapter.commitMigration(idFromPath(fixture.path), toTypeId, content);

      const [url, init] = mockFetch.mock.lastCall as [string, RequestInit];
      expect(url).toBe(`${BASE_URL}${fixture.path}`);
      expect(init.method).toBe(fixture.method);
      expect(JSON.parse(init.body as string)).toEqual(fixture.requestBody);
      expect(result.typeId).toBe(fixture.responseBody!.typeId);
    });
  }
});

// -------------------------------------------------------
// Error responses (#53) — pins that APIAdapter reconstructs the documented
// core error class from each fixture's wire error body.
// -------------------------------------------------------

const ERROR_CLASS_FOR_CODE = {
  permission: StackPermissionError,
  not_found: StackNotFoundError,
  conflict: StackConflictError,
  validation: StackValidationError,
  bad_request: StackQueryError,
} as const;

describe('error response fixtures', () => {
  for (const fixture of errorResponseFixtures) {
    test(fixture.name, async () => {
      const adapter = await openAdapter();
      mockFetch.mockResolvedValueOnce(jsonResponse(fixture.responseBody, fixture.responseStatus));

      const dispatch = (): Promise<unknown> => {
        if (fixture.method === 'POST' && fixture.path === '/records') {
          const body = fixture.requestBody as Record<string, unknown>;
          return adapter.createRecord({
            id: body.id as string,
            typeId: body.typeId as string,
            createdAt: new Date(body.createdAt as string),
            updatedAt: new Date(body.updatedAt as string),
            content: body.content as Record<string, unknown>,
            version: body.version as number,
          });
        }
        if (fixture.method === 'POST' && fixture.path === '/records/query') {
          return adapter.queryRecords(fixture.requestBody as never);
        }
        if (fixture.method === 'POST' && fixture.path.includes('/restore/')) {
          const version = Number(fixture.path.split('/').pop());
          return adapter.restoreVersion(idFromPath(fixture.path), version);
        }
        if (fixture.method === 'PATCH') {
          return adapter.patchContent(
            idFromPath(fixture.path),
            fixture.requestBody as Record<string, unknown>,
          );
        }
        throw new Error(`no dispatch wired for error fixture "${fixture.name}"`);
      };

      const code = (fixture.responseBody as { error: { code: keyof typeof ERROR_CLASS_FOR_CODE } })
        .error.code;
      await expect(dispatch()).rejects.toThrow(ERROR_CLASS_FOR_CODE[code]);

      const [url, init] = mockFetch.mock.lastCall as [string, RequestInit];
      expect(url).toBe(`${BASE_URL}${fixture.path}`);
      expect(init.method).toBe(fixture.method);
    });
  }
});

// -------------------------------------------------------
// Attachment upload fixtures (#106) — POST /attachments carries Content-Type
// and creates the record. Only fixtures with a Content-Type header are
// dispatched here: putAttachmentWithMetadata()'s mimeType is required, so
// there is no way to drive the "header omitted" fixture through it — that
// one documents the raw wire contract for non-SDK callers only, same as
// attachmentDownloadFixtures aren't all exercised via APIAdapter either.
// -------------------------------------------------------

describe('attachment upload fixtures', () => {
  for (const fixture of attachmentUploadFixtures) {
    const contentType = fixture.requestHeaders['Content-Type'];
    if (!contentType) continue;

    test(fixture.name, async () => {
      const adapter = await openAdapter();
      mockFetch.mockResolvedValueOnce(jsonResponse(fixture.responseBody, fixture.responseStatus));

      const disposition = fixture.requestHeaders['Content-Disposition'];
      const filenameMatch = disposition?.match(/filename\*=UTF-8''(.+)$/);
      const filename = filenameMatch ? decodeURIComponent(filenameMatch[1]) : undefined;
      const data = new Uint8Array(fixture.requestBodyBytes);

      const dispatch = () => adapter.putAttachmentWithMetadata(data, contentType, filename);

      if (fixture.responseStatus >= 400) {
        const code = (
          fixture.responseBody as { error: { code: keyof typeof ERROR_CLASS_FOR_CODE } }
        ).error.code;
        await expect(dispatch()).rejects.toThrow(ERROR_CLASS_FOR_CODE[code]);
      } else {
        const record = await dispatch();
        const expectedFileId = (fixture.responseBody as unknown as { content: { fileId: string } })
          .content.fileId;
        expect(record.content.fileId).toBe(expectedFileId);
      }

      const [url, init] = mockFetch.mock.lastCall as [string, RequestInit];
      expect(url).toBe(`${BASE_URL}/attachments`);
      expect(init.method).toBe('POST');
      const headers = init.headers as Record<string, string>;
      expect(headers['Content-Type']).toBe(contentType);
      if (disposition) expect(headers['Content-Disposition']).toBe(disposition);
    });
  }
});
