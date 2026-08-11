/**
 * Drives APIAdapter through the shared wire-protocol fixtures from
 * @haverstack/conformance-fixtures, asserting it produces the documented
 * request for each fixture and parses the documented response. The same
 * fixtures are importable by a server implementation to assert the mirror
 * image: that its HTTP handlers accept the documented request and produce
 * the documented response. See that package for the fixture data itself.
 */
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { APIAdapter, APIAdapterAuthError } from '../src/index.js';
import {
  createRecordFixtures,
  patchContentFixtures,
  deleteRecordFixtures,
  undeleteRecordFixtures,
  associateFixtures,
  dissociateFixtures,
  setPermissionsFixtures,
  getVersionsFixtures,
  getVersionFixtures,
  getVersionsAfterMutateFixtures,
  restoreVersionFixtures,
  commitMigrationFixtures,
  discoveryFixtures,
  errorResponseFixtures,
  attachmentUploadFixtures,
  authChallengeFixtures,
  authTokenFixtures,
  AUTH_FIXTURE_ORIGIN,
  AUTH_FIXTURE_DID,
  AUTH_FIXTURE_NONCE,
  AUTH_FIXTURE_PAYLOAD,
  AUTH_FIXTURE_SIGNATURE,
  AUTH_FIXTURE_FOREIGN_SIGNATURE,
} from '@haverstack/conformance-fixtures';
import type { Association, StackType } from '@haverstack/core';
import {
  StackPermissionError,
  StackNotFoundError,
  StackConflictError,
  StackValidationError,
  StackQueryError,
  StackVersionConflictError,
  StackSchemaDriftError,
  StackPayloadTooLargeError,
  buildAuthChallengePayload,
  verifyAuthChallenge,
  base64urlDecode,
  generateDidKeypair,
  didCredentialFromKeypair,
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

describe('discovery fixtures', () => {
  for (const fixture of discoveryFixtures) {
    test(fixture.name, async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse(fixture.responseBody, fixture.responseStatus));
      const adapter = await APIAdapter.open({ url: BASE_URL });

      const [url] = mockFetch.mock.lastCall as [string, RequestInit];
      expect(url).toBe(`${BASE_URL}${fixture.path}`);
      expect(adapter.ownerEntityId).toBe(fixture.responseBody!.entityId);
      expect(adapter.timezone).toBe(fixture.responseBody!.timezone);
      expect(adapter.capabilities).toEqual(fixture.responseBody!.capabilities);
    });
  }
});

// The handshake fixtures carry a real DID, nonce and signature, so they
// pin the payload construction itself rather than only the JSON envelope
// around it — a server can verify one instead of trusting its own
// derivation. These assert the fixture data and core's implementation
// agree, in both directions.
describe('auth handshake fixtures', () => {
  const fixtureChallenge = {
    origin: AUTH_FIXTURE_ORIGIN,
    did: AUTH_FIXTURE_DID,
    nonce: AUTH_FIXTURE_NONCE,
  };

  test('the payload core builds is the one the fixtures document', () => {
    expect(new TextDecoder().decode(buildAuthChallengePayload(fixtureChallenge))).toBe(
      AUTH_FIXTURE_PAYLOAD,
    );
  });

  test('the fixture signature verifies against that payload', async () => {
    expect(
      await verifyAuthChallenge(fixtureChallenge, base64urlDecode(AUTH_FIXTURE_SIGNATURE)),
    ).toBe(true);
  });

  test('the foreign-signature fixture is well-formed and verifies for nobody', async () => {
    // Decodes as a signature — the fixture pins a rejected credential, not
    // a malformed request, so it has to be a real signature by another key.
    expect(base64urlDecode(AUTH_FIXTURE_FOREIGN_SIGNATURE).length).toBe(64);
    expect(
      await verifyAuthChallenge(fixtureChallenge, base64urlDecode(AUTH_FIXTURE_FOREIGN_SIGNATURE)),
    ).toBe(false);
  });

  test('the fixture signature does not verify for another origin', async () => {
    expect(
      await verifyAuthChallenge(
        { ...fixtureChallenge, origin: 'https://impostor.example.net' },
        base64urlDecode(AUTH_FIXTURE_SIGNATURE),
      ),
    ).toBe(false);
  });

  const challengeFixture = authChallengeFixtures.find(
    (f) => f.name === 'auth-challenge-issues-nonce',
  )!;
  const tokenFixture = authTokenFixtures.find((f) => f.name === 'auth-token-issues-bearer-token')!;

  test('APIAdapter performs the documented handshake and uses the token it earns', async () => {
    const credential = didCredentialFromKeypair(await generateDidKeypair());

    mockFetch.mockResolvedValueOnce(
      jsonResponse({ ...DISCOVERY, auth: { methods: ['did-challenge'] } }),
    );
    mockFetch.mockResolvedValueOnce(jsonResponse(challengeFixture.responseBody));
    mockFetch.mockResolvedValueOnce(jsonResponse(tokenFixture.responseBody));

    const adapter = await APIAdapter.open({ url: BASE_URL, credential });

    const [challengeUrl, challengeInit] = mockFetch.mock.calls[1] as [string, RequestInit];
    expect(challengeUrl).toBe(`${BASE_URL}${challengeFixture.path}`);
    expect(challengeInit.method).toBe(challengeFixture.method);
    expect(JSON.parse(challengeInit.body as string)).toEqual({ did: credential.did });

    const [tokenUrl, tokenInit] = mockFetch.mock.calls[2] as [string, RequestInit];
    expect(tokenUrl).toBe(`${BASE_URL}${tokenFixture.path}`);
    expect(tokenInit.method).toBe(tokenFixture.method);
    const sent = JSON.parse(tokenInit.body as string) as Record<string, string>;
    expect(sent.did).toBe(credential.did);
    expect(sent.nonce).toBe(AUTH_FIXTURE_NONCE);
    // The adapter signs with its own key, so what is pinned is that the
    // signature it sends verifies for the challenge it was answering.
    expect(
      await verifyAuthChallenge(
        { origin: BASE_URL, did: credential.did, nonce: AUTH_FIXTURE_NONCE },
        base64urlDecode(sent.signature),
      ),
    ).toBe(true);

    mockFetch.mockResolvedValueOnce(jsonResponse([]));
    await adapter.listTypes();
    const [, init] = mockFetch.mock.lastCall as [string, RequestInit];
    expect((init.headers as Record<string, string>)['Authorization']).toBe(
      `Bearer ${(tokenFixture.responseBody as { token: string }).token}`,
    );
  });
});

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

describe('getVersions fixtures', () => {
  for (const fixture of getVersionsFixtures) {
    test(fixture.name, async () => {
      const adapter = await openAdapter();
      mockFetch.mockResolvedValueOnce(jsonResponse(fixture.responseBody, fixture.responseStatus));

      const result = await adapter.getVersions(idFromPath(fixture.path));

      const [url, init] = mockFetch.mock.lastCall as [string, RequestInit];
      expect(url).toBe(`${BASE_URL}${fixture.path}`);
      expect(init.method).toBe(fixture.method);
      expect(result).toHaveLength(fixture.responseBody!.length);
      expect(result[0].permissions).toEqual(fixture.responseBody![0].permissions);
    });
  }
});

describe('getVersion fixtures', () => {
  for (const fixture of getVersionFixtures) {
    test(fixture.name, async () => {
      const adapter = await openAdapter();
      mockFetch.mockResolvedValueOnce(jsonResponse(fixture.responseBody, fixture.responseStatus));

      const [id, , version] = fixture.path.split('/').slice(2);
      const result = await adapter.getVersion(id, Number(version));

      const [url, init] = mockFetch.mock.lastCall as [string, RequestInit];
      expect(url).toBe(`${BASE_URL}${fixture.path}`);
      expect(init.method).toBe(fixture.method);
      expect(result?.permissions).toBeUndefined();
    });
  }
});

// pins the response shape a version-count-increment check would parse
// after POST /migrate or POST /restore/:version. See the fixtures'
// description for why this suite (mocked transport, no real backing store)
// can't itself observe the count actually growing — a real server-side
// conformance run dispatches the paired mutating fixture first.
describe('getVersions after migrate/restore fixtures', () => {
  for (const fixture of getVersionsAfterMutateFixtures) {
    test(fixture.name, async () => {
      const adapter = await openAdapter();
      mockFetch.mockResolvedValueOnce(jsonResponse(fixture.responseBody, fixture.responseStatus));

      const result = await adapter.getVersions(idFromPath(fixture.path));

      const [url, init] = mockFetch.mock.lastCall as [string, RequestInit];
      expect(url).toBe(`${BASE_URL}${fixture.path}`);
      expect(init.method).toBe(fixture.method);
      expect(result.map((v) => v.version)).toEqual(fixture.responseBody!.map((v) => v.version));
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
// Error responses — pins that APIAdapter reconstructs the documented
// core error class from each fixture's wire error body.
// -------------------------------------------------------

const ERROR_CLASS_FOR_CODE = {
  permission: StackPermissionError,
  not_found: StackNotFoundError,
  conflict: StackConflictError,
  validation: StackValidationError,
  bad_request: StackQueryError,
  version_conflict: StackVersionConflictError,
  schema_drift: StackSchemaDriftError,
  payload_too_large: StackPayloadTooLargeError,
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
        if (fixture.method === 'POST' && fixture.path === '/types') {
          const { createdAt, ...rest } = fixture.requestBody as Record<string, unknown>;
          return adapter.saveType({
            ...(rest as Omit<StackType, 'createdAt'>),
            createdAt: new Date(createdAt as string),
          });
        }
        if (fixture.method === 'POST' && fixture.path.includes('/restore/')) {
          const version = Number(fixture.path.split('/').pop());
          return adapter.restoreVersion(idFromPath(fixture.path), version);
        }
        if (fixture.method === 'GET' && fixture.path.endsWith('/versions')) {
          return adapter.getVersions(idFromPath(fixture.path));
        }
        if (fixture.method === 'DELETE') {
          return adapter.deleteRecord(idFromPath(fixture.path));
        }
        if (fixture.method === 'PATCH') {
          // If-Match (see error-version-conflict-if-match-mismatch) travels as a quoted
          // version number, matching the header APIAdapter itself sends for ifVersion.
          const ifMatch = fixture.requestHeaders?.['If-Match'];
          const expectedVersion = ifMatch ? Number(ifMatch.replace(/"/g, '')) : undefined;
          return adapter.patchContent(
            idFromPath(fixture.path),
            fixture.requestBody as Record<string, unknown>,
            { expectedVersion },
          );
        }
        throw new Error(`no dispatch wired for error fixture "${fixture.name}"`);
      };

      // 401 (error-unauthorized-anonymous) carries no wire error body, so it can't be
      // routed through the code->class map below; APIAdapter reconstructs it from status
      // alone as APIAdapterAuthError.
      if (fixture.responseStatus === 401) {
        await expect(dispatch()).rejects.toThrow(APIAdapterAuthError);
      } else {
        const code = (
          fixture.responseBody as { error: { code: keyof typeof ERROR_CLASS_FOR_CODE } }
        ).error.code;
        await expect(dispatch()).rejects.toThrow(ERROR_CLASS_FOR_CODE[code]);
      }

      const [url, init] = mockFetch.mock.lastCall as [string, RequestInit];
      expect(url).toBe(`${BASE_URL}${fixture.path}`);
      expect(init.method).toBe(fixture.method);
      if (fixture.requestHeaders) {
        const headers = init.headers as Record<string, string>;
        for (const [key, value] of Object.entries(fixture.requestHeaders)) {
          expect(headers[key]).toBe(value);
        }
      }
    });
  }
});

// -------------------------------------------------------
// Attachment upload fixtures. Only fixtures with a Content-Type header
// are dispatched here: putAttachmentWithMetadata()'s mimeType is
// required, so the "header omitted" fixture documents the raw wire
// contract for non-SDK callers only.
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

      const dispatch = () =>
        adapter.putAttachmentWithMetadata(data, contentType, filename, fixture.appId);

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
      const query = fixture.appId ? `?appId=${encodeURIComponent(fixture.appId)}` : '';
      expect(url).toBe(`${BASE_URL}/attachments${query}`);
      expect(init.method).toBe('POST');
      const headers = init.headers as Record<string, string>;
      expect(headers['Content-Type']).toBe(contentType);
      if (disposition) expect(headers['Content-Disposition']).toBe(disposition);
    });
  }
});
