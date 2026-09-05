import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  APIAdapter,
  APIAdapterAuthError,
  APIAdapterConnectionError,
  APIAdapterError,
  APIAdapterCapabilityError,
  APIAdapterVersionError,
  APIAdapterOwnerMismatchError,
  APIAdapterAuthUnsupportedError,
  APIAdapterHandshakeError,
  APIAdapterReauthError,
  APIAdapterInsecureUrlError,
} from '../src/index.js';
import { buildAuthChallengePayload } from '@haverstack/core/wire';
import { WIRE_PROTOCOL_VERSION } from '@haverstack/wire-types';
import type { DiscoveryCapabilities } from '@haverstack/wire-types';
import type { StackRecord, StackType, RecordVersion, Association } from '@haverstack/core';
import {
  StackPermissionError,
  StackNotFoundError,
  StackConflictError,
  StackVersionConflictError,
  StackValidationError,
  StackQueryError,
  StackMigrationError,
  StackPayloadTooLargeError,
} from '@haverstack/core';

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
    filter: { content: 'path', contentPresent: true, search: true },
    sort: { fields: ['createdAt', 'updatedAt', 'version'], contentField: true },
    // contentBytes omitted: a server declaring one limit and not the other
    // is the case the null default exists for.
    limits: { attachmentBytes: 52428800 },
  } satisfies DiscoveryCapabilities,
};

/** DISCOVERY with individual capabilities overridden, groups left intact. */
const discoveryWith = (caps: DiscoveryCapabilities) => ({
  ...DISCOVERY,
  capabilities: {
    filter: { ...DISCOVERY.capabilities.filter, ...caps.filter },
    sort: { ...DISCOVERY.capabilities.sort, ...caps.sort },
    limits: { ...DISCOVERY.capabilities.limits, ...caps.limits },
  },
});

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
  typeId: 'com.example/note@1',
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

  // Everything this adapter carries over the wire — a bearer token, a
  // handshake signature, the records themselves — is readable and
  // rewritable by anything on the path of a plaintext connection.
  describe('plaintext URLs', () => {
    test('refuses http:// to a remote host, before sending anything', async () => {
      await expect(
        APIAdapter.open({ url: 'http://stack.example.com', token: TOKEN }),
      ).rejects.toBeInstanceOf(APIAdapterInsecureUrlError);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    test.each(['http://localhost:8787', 'http://127.0.0.1:8787', 'http://[::1]:8787'])(
      'allows %s without a flag',
      async (url) => {
        mockFetch.mockResolvedValueOnce(jsonResponse(DISCOVERY));
        await expect(APIAdapter.open({ url, token: TOKEN })).resolves.toBeInstanceOf(APIAdapter);
      },
    );

    test('allows a remote http:// host with allowInsecure', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse(DISCOVERY));
      await expect(
        APIAdapter.open({ url: 'http://stack.example.com', token: TOKEN, allowInsecure: true }),
      ).resolves.toBeInstanceOf(APIAdapter);
    });

    // A name is matched, never resolved: that a host resolves to loopback
    // now is not a promise about where the next request goes.
    test('a non-loopback name is refused however it resolves', async () => {
      await expect(
        APIAdapter.open({ url: 'http://localhost.example.com', token: TOKEN }),
      ).rejects.toBeInstanceOf(APIAdapterInsecureUrlError);
    });

    test('https:// needs no flag', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse(DISCOVERY));
      await expect(
        APIAdapter.open({ url: 'https://stack.example.com', token: TOKEN }),
      ).resolves.toBeInstanceOf(APIAdapter);
    });
  });

  test('populates capabilities from discovery response', async () => {
    const adapter = await openAdapter();
    expect(adapter.capabilities.filter.search).toBe(true);
    expect(adapter.capabilities.filter.content).toBe('path');
    expect(adapter.capabilities.sort.fields).toEqual(['createdAt', 'updatedAt', 'version']);
    expect(adapter.capabilities.limits.attachmentBytes).toBe(52428800);
  });

  test('populates limits.contentBytes from discovery response', async () => {
    const adapter = await openAdapter(discoveryWith({ limits: { contentBytes: 1048576 } }));
    expect(adapter.capabilities.limits.contentBytes).toBe(1048576);
  });

  // "Can't pre-check" — not "unbounded", and not undefined leaking into
  // the numeric comparison Stack.create() makes against it. The server's
  // own request-size limit is authoritative regardless.
  test('reports limits.contentBytes as null when a server does not declare one', async () => {
    const adapter = await openAdapter();
    expect(adapter.capabilities.limits.contentBytes).toBeNull();
  });

  test('populates ownerEntityId from discovery response', async () => {
    const adapter = await openAdapter();
    expect(adapter.ownerEntityId).toBe('entity-owner-123');
  });

  test('populates timezone from discovery response', async () => {
    const adapter = await openAdapter();
    expect(adapter.timezone).toBe('America/New_York');
  });

  // timezone is passthrough metadata only — no 'UTC' default, which
  // would claim knowledge the discovery response didn't actually provide.
  test('timezone is undefined when not in discovery response — no default', async () => {
    const adapter = await openAdapter({ ...DISCOVERY, timezone: undefined });
    expect(adapter.timezone).toBeUndefined();
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
// open() — wire protocol version negotiation
// -------------------------------------------------------

describe('open — version negotiation', () => {
  test('opens against a server declaring this client’s protocol version', async () => {
    const adapter = await openAdapter({ ...DISCOVERY, version: WIRE_PROTOCOL_VERSION });
    expect(adapter.ownerEntityId).toBe('entity-owner-123');
  });

  test('refuses a server whose protocol major differs', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ ...DISCOVERY, version: '2.0' }));
    await expect(APIAdapter.open({ url: BASE_URL, token: TOKEN })).rejects.toThrow(
      APIAdapterVersionError,
    );
  });

  test('a higher server minor opens — added fields an older client ignores', async () => {
    const adapter = await openAdapter({ ...DISCOVERY, version: '1.7' });
    expect(adapter.ownerEntityId).toBe('entity-owner-123');
  });

  test('a lower server minor opens — omitted fields an older server never had', async () => {
    const adapter = await openAdapter({ ...DISCOVERY, version: '1.0' });
    expect(adapter.ownerEntityId).toBe('entity-owner-123');
  });

  test('refuses discovery with no version at all', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ ...DISCOVERY, version: undefined }));
    await expect(APIAdapter.open({ url: BASE_URL, token: TOKEN })).rejects.toThrow(
      APIAdapterVersionError,
    );
  });

  test('refuses a version that is not MAJOR.MINOR', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ ...DISCOVERY, version: 'v1' }));
    await expect(APIAdapter.open({ url: BASE_URL, token: TOKEN })).rejects.toThrow(
      APIAdapterVersionError,
    );
  });

  test('carries the offending version for a caller that wants to report it', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ ...DISCOVERY, version: '2.0' }));
    const err = await APIAdapter.open({ url: BASE_URL, token: TOKEN }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(APIAdapterVersionError);
    expect((err as APIAdapterVersionError).serverVersion).toBe('2.0');
  });

  test('refuses before sending any other request', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ ...DISCOVERY, version: '2.0' }));
    await expect(APIAdapter.open({ url: BASE_URL, token: TOKEN })).rejects.toThrow(
      APIAdapterVersionError,
    );
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

// -------------------------------------------------------
// open() — expectedOwner
// -------------------------------------------------------

// Discovery identity is unsigned and the server can't prove it, so stating
// the DID you expect is the only check a client has. See
// docs/spec/wire-format.md § Identity is trusted on transport.
describe('open — expectedOwner', () => {
  const OWNER_DID = 'did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK';
  const OTHER_DID = 'did:key:z6MkjchhfUsD6mmvni8mCdXHw216Xrm9bQe2mBH1P5RDjVJG';
  const ownedDiscovery = { ...DISCOVERY, entityId: OWNER_DID };

  test('opens when discovery reports the expected owner', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(ownedDiscovery));
    const adapter = await APIAdapter.open({
      url: BASE_URL,
      token: TOKEN,
      expectedOwner: OWNER_DID,
    });
    expect(adapter.ownerEntityId).toBe(OWNER_DID);
  });

  test('refuses a server reporting a different owner', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ ...DISCOVERY, entityId: OTHER_DID }));
    await expect(
      APIAdapter.open({ url: BASE_URL, token: TOKEN, expectedOwner: OWNER_DID }),
    ).rejects.toThrow(APIAdapterOwnerMismatchError);
  });

  test('carries both DIDs for a caller that wants to report them', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ ...DISCOVERY, entityId: OTHER_DID }));
    const err = await APIAdapter.open({
      url: BASE_URL,
      token: TOKEN,
      expectedOwner: OWNER_DID,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(APIAdapterOwnerMismatchError);
    expect((err as APIAdapterOwnerMismatchError).expectedOwner).toBe(OWNER_DID);
    expect((err as APIAdapterOwnerMismatchError).actualOwner).toBe(OTHER_DID);
  });

  test('refuses discovery carrying no owner at all — absence is not a match', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ ...DISCOVERY, entityId: undefined }));
    await expect(
      APIAdapter.open({ url: BASE_URL, token: TOKEN, expectedOwner: OWNER_DID }),
    ).rejects.toThrow(APIAdapterOwnerMismatchError);
  });

  test('compares exactly — a DID differing only in case is a mismatch', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ ...DISCOVERY, entityId: OWNER_DID }));
    await expect(
      APIAdapter.open({ url: BASE_URL, token: TOKEN, expectedOwner: OWNER_DID.toLowerCase() }),
    ).rejects.toThrow(APIAdapterOwnerMismatchError);
  });

  test('an omitted expectedOwner opens against whatever owner is reported', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ ...DISCOVERY, entityId: OTHER_DID }));
    const adapter = await APIAdapter.open({ url: BASE_URL, token: TOKEN });
    expect(adapter.ownerEntityId).toBe(OTHER_DID);
  });

  test('refuses before sending any other request', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ ...DISCOVERY, entityId: OTHER_DID }));
    await expect(
      APIAdapter.open({ url: BASE_URL, token: TOKEN, expectedOwner: OWNER_DID }),
    ).rejects.toThrow(APIAdapterOwnerMismatchError);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  // A differing major means discovery's fields may not mean what this client
  // reads them as, so entityId isn't worth comparing yet.
  test('an incompatible protocol major is refused ahead of the owner check', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ ...DISCOVERY, version: '2.0', entityId: OTHER_DID }),
    );
    await expect(
      APIAdapter.open({ url: BASE_URL, token: TOKEN, expectedOwner: OWNER_DID }),
    ).rejects.toThrow(APIAdapterVersionError);
  });
});

// -------------------------------------------------------
// open() — DID credential handshake
// -------------------------------------------------------

const AUTH_DISCOVERY = { ...DISCOVERY, auth: { methods: ['did-challenge'] } };
const NONCE = 'k7Qm2ZxRt9vLbNc4Hy8Wf3';
const EARNED_TOKEN = 'earned-token-1';

const challengeResponse = (nonce = NONCE): Response =>
  jsonResponse({ nonce, expiresAt: '2024-06-15T12:05:00.000Z' });

const tokenResponse = (token = EARNED_TOKEN, did = 'did:key:zStub'): Response =>
  jsonResponse({ token, principalId: did, subjectId: did });

const authError = (code: string, status = 401): Response =>
  jsonResponse({ error: { code, message: code } }, status);

/** A credential whose signatures are inspectable without real crypto. */
const stubCredential = (did = 'did:key:zStub') => ({
  did,
  sign: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3])),
});

describe('open — DID credential handshake', () => {
  test('earns a token and sends it on subsequent requests', async () => {
    const credential = stubCredential();
    mockFetch.mockResolvedValueOnce(jsonResponse(AUTH_DISCOVERY));
    mockFetch.mockResolvedValueOnce(challengeResponse());
    mockFetch.mockResolvedValueOnce(tokenResponse());

    const adapter = await APIAdapter.open({ url: BASE_URL, credential });
    mockFetch.mockResolvedValueOnce(jsonResponse([]));
    await adapter.listTypes();

    const [, init] = mockFetch.mock.lastCall as [string, RequestInit];
    expect((init.headers as Record<string, string>)['Authorization']).toBe(
      `Bearer ${EARNED_TOKEN}`,
    );
  });

  test('signs the payload built for the server it dialed, not the bare nonce', async () => {
    const credential = stubCredential();
    mockFetch.mockResolvedValueOnce(jsonResponse(AUTH_DISCOVERY));
    mockFetch.mockResolvedValueOnce(challengeResponse());
    mockFetch.mockResolvedValueOnce(tokenResponse());

    await APIAdapter.open({ url: BASE_URL, credential });

    expect(credential.sign).toHaveBeenCalledWith(
      buildAuthChallengePayload({ origin: BASE_URL, did: credential.did, nonce: NONCE }),
    );
  });

  test('refuses a server that does not advertise the handshake', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(DISCOVERY));
    await expect(APIAdapter.open({ url: BASE_URL, credential: stubCredential() })).rejects.toThrow(
      APIAdapterAuthUnsupportedError,
    );
  });

  test('refuses before signing anything when the handshake is unadvertised', async () => {
    const credential = stubCredential();
    mockFetch.mockResolvedValueOnce(jsonResponse(DISCOVERY));
    await APIAdapter.open({ url: BASE_URL, credential }).catch(() => undefined);
    expect(credential.sign).not.toHaveBeenCalled();
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  // A signature keeps its value after the connection is abandoned, so it is
  // never spent on a server this client has already decided to refuse.
  test('does not handshake against a server failing the expectedOwner check', async () => {
    const credential = stubCredential();
    mockFetch.mockResolvedValueOnce(jsonResponse(AUTH_DISCOVERY));
    await APIAdapter.open({
      url: BASE_URL,
      credential,
      expectedOwner: 'did:key:zSomeoneElse',
    }).catch(() => undefined);
    expect(credential.sign).not.toHaveBeenCalled();
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  test('refuses a token and a credential together', async () => {
    await expect(
      APIAdapter.open({ url: BASE_URL, token: TOKEN, credential: stubCredential() }),
    ).rejects.toThrow(APIAdapterError);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test('surfaces a rejected signature as a fatal handshake error', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(AUTH_DISCOVERY));
    mockFetch.mockResolvedValueOnce(challengeResponse());
    mockFetch.mockResolvedValueOnce(authError('invalid_signature'));

    const err = await APIAdapter.open({ url: BASE_URL, credential: stubCredential() }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(APIAdapterHandshakeError);
    expect((err as APIAdapterHandshakeError).code).toBe('invalid_signature');
  });

  // The window between issuing a nonce and signing it is small but real,
  // and losing that race is not a credential failure.
  test('retries once from a fresh nonce when the first is already stale', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(AUTH_DISCOVERY));
    mockFetch.mockResolvedValueOnce(challengeResponse());
    mockFetch.mockResolvedValueOnce(authError('expired_nonce'));
    mockFetch.mockResolvedValueOnce(challengeResponse('SecondNonce123'));
    mockFetch.mockResolvedValueOnce(tokenResponse());

    const adapter = await APIAdapter.open({ url: BASE_URL, credential: stubCredential() });
    expect(adapter.ownerEntityId).toBe('entity-owner-123');
  });

  test('gives up after one stale-nonce retry rather than looping', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(AUTH_DISCOVERY));
    mockFetch.mockResolvedValueOnce(challengeResponse());
    mockFetch.mockResolvedValueOnce(authError('expired_nonce'));
    mockFetch.mockResolvedValueOnce(challengeResponse('SecondNonce123'));
    mockFetch.mockResolvedValueOnce(authError('expired_nonce'));

    await expect(APIAdapter.open({ url: BASE_URL, credential: stubCredential() })).rejects.toThrow(
      APIAdapterHandshakeError,
    );
    expect(mockFetch).toHaveBeenCalledTimes(5);
  });

  test('a rejected signature is not retried', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(AUTH_DISCOVERY));
    mockFetch.mockResolvedValueOnce(challengeResponse());
    mockFetch.mockResolvedValueOnce(authError('invalid_signature'));

    await APIAdapter.open({ url: BASE_URL, credential: stubCredential() }).catch(() => undefined);
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });
});

// -------------------------------------------------------
// Session renewal on 401
// -------------------------------------------------------

describe('re-authentication', () => {
  /** Open with a credential, consuming discovery + handshake. */
  const openWithCredential = async (credential = stubCredential()): Promise<APIAdapter> => {
    mockFetch.mockResolvedValueOnce(jsonResponse(AUTH_DISCOVERY));
    mockFetch.mockResolvedValueOnce(challengeResponse());
    mockFetch.mockResolvedValueOnce(tokenResponse());
    return APIAdapter.open({ url: BASE_URL, credential });
  };

  const authHeader = (call: number): string | undefined => {
    const [, init] = mockFetch.mock.calls[call] as [string, RequestInit];
    return (init.headers as Record<string, string>)['Authorization'];
  };

  test('renews the session on 401 and repeats the request with the new token', async () => {
    const adapter = await openWithCredential();
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 401 }));
    mockFetch.mockResolvedValueOnce(challengeResponse('SecondNonce123'));
    mockFetch.mockResolvedValueOnce(tokenResponse('renewed-token'));
    mockFetch.mockResolvedValueOnce(jsonResponse(RECORD_RAW));

    const record = await adapter.getRecord('rec-abc123');
    expect(record?.id).toBe('rec-abc123');
    expect(authHeader(3)).toBe(`Bearer ${EARNED_TOKEN}`);
    expect(authHeader(6)).toBe('Bearer renewed-token');
  });

  test('renews on 401 from a binary download too', async () => {
    const adapter = await openWithCredential();
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 401 }));
    mockFetch.mockResolvedValueOnce(challengeResponse('SecondNonce123'));
    mockFetch.mockResolvedValueOnce(tokenResponse('renewed-token'));
    mockFetch.mockResolvedValueOnce(new Response(new Uint8Array([7, 8, 9])));

    expect(await adapter.getAttachment('file-1')).toEqual(new Uint8Array([7, 8, 9]));
    expect(authHeader(6)).toBe('Bearer renewed-token');
  });

  test('renews on 401 from an upload too', async () => {
    const adapter = await openWithCredential();
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 401 }));
    mockFetch.mockResolvedValueOnce(challengeResponse('SecondNonce123'));
    mockFetch.mockResolvedValueOnce(tokenResponse('renewed-token'));
    mockFetch.mockResolvedValueOnce(jsonResponse(RECORD_RAW));

    await adapter.putAttachmentWithMetadata(new Uint8Array([1]), 'text/plain');
    expect(authHeader(6)).toBe('Bearer renewed-token');
  });

  test('a 401 that survives renewal is an APIAdapterReauthError, not a bare auth error', async () => {
    const adapter = await openWithCredential();
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 401 }));
    mockFetch.mockResolvedValueOnce(challengeResponse('SecondNonce123'));
    mockFetch.mockResolvedValueOnce(tokenResponse('renewed-token'));
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 401 }));

    const err = await adapter.getRecord('rec-abc123').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(APIAdapterReauthError);
  });

  test('retries once, never looping', async () => {
    const adapter = await openWithCredential();
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 401 }));
    mockFetch.mockResolvedValueOnce(challengeResponse('SecondNonce123'));
    mockFetch.mockResolvedValueOnce(tokenResponse('renewed-token'));
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 401 }));

    await adapter.getRecord('rec-abc123').catch(() => undefined);
    // discovery + handshake (2) + request + handshake (2) + retry
    expect(mockFetch).toHaveBeenCalledTimes(7);
  });

  test('a failed renewal surfaces as APIAdapterReauthError carrying its cause', async () => {
    const adapter = await openWithCredential();
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 401 }));
    mockFetch.mockResolvedValueOnce(challengeResponse('SecondNonce123'));
    mockFetch.mockResolvedValueOnce(authError('invalid_signature'));

    const err = await adapter.getRecord('rec-abc123').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(APIAdapterReauthError);
    expect((err as APIAdapterReauthError).cause).toBeInstanceOf(APIAdapterHandshakeError);
  });

  // Concurrent requests finding the same token stale share one handshake:
  // the alternative spends a signature per in-flight request and leaves the
  // last one to win.
  test('coalesces concurrent renewals into a single handshake', async () => {
    const adapter = await openWithCredential();
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 401 }));
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 401 }));
    mockFetch.mockResolvedValueOnce(challengeResponse('SecondNonce123'));
    mockFetch.mockResolvedValueOnce(tokenResponse('renewed-token'));
    mockFetch.mockResolvedValueOnce(jsonResponse(RECORD_RAW));
    mockFetch.mockResolvedValueOnce(jsonResponse(RECORD_RAW));

    await Promise.all([adapter.getRecord('rec-abc123'), adapter.getRecord('rec-abc123')]);

    const challenges = mockFetch.mock.calls.filter(
      ([url]) => (url as string) === `${BASE_URL}/auth/challenge`,
    );
    expect(challenges.length).toBe(2); // one at open(), one shared by both 401s
  });

  test('without a credential a 401 stays an APIAdapterAuthError', async () => {
    const adapter = await openAdapter();
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 401 }));

    const err = await adapter.getRecord('rec-abc123').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(APIAdapterAuthError);
    expect(err).not.toBeInstanceOf(APIAdapterReauthError);
    expect(mockFetch).toHaveBeenCalledTimes(2);
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
// patchContent
// -------------------------------------------------------

describe('patchContent', () => {
  test('sends PATCH /records/:id', async () => {
    const adapter = await openAdapter();
    const updated = { ...RECORD_RAW, content: { text: 'Updated' }, version: 2 };
    mockFetch.mockResolvedValueOnce(jsonResponse(updated));
    await adapter.patchContent('rec-abc123', { text: 'Updated' });
    expect(mockFetch).toHaveBeenLastCalledWith(
      `${BASE_URL}/records/rec-abc123`,
      expect.objectContaining({ method: 'PATCH' }),
    );
  });

  test('sends only the raw patch — no record fields — as the body', async () => {
    const adapter = await openAdapter();
    const updated = { ...RECORD_RAW, content: { text: 'Updated' }, version: 2 };
    mockFetch.mockResolvedValueOnce(jsonResponse(updated));
    await adapter.patchContent('rec-abc123', { text: 'Updated', removedField: null });
    const [, init] = mockFetch.mock.lastCall as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ text: 'Updated', removedField: null });
  });

  test('returns updated record with parsed dates', async () => {
    const adapter = await openAdapter();
    const updated = { ...RECORD_RAW, content: { text: 'Updated' }, version: 2 };
    mockFetch.mockResolvedValueOnce(jsonResponse(updated));
    const result = await adapter.patchContent('rec-abc123', { text: 'Updated' });
    expect(result.content).toEqual({ text: 'Updated' });
    expect(result.updatedAt).toBeInstanceOf(Date);
  });

  test('sends If-Match when expectedVersion is given', async () => {
    const adapter = await openAdapter();
    mockFetch.mockResolvedValueOnce(jsonResponse(RECORD_RAW));
    await adapter.patchContent('rec-abc123', { text: 'x' }, { expectedVersion: 5 });
    const [, init] = mockFetch.mock.lastCall as [string, RequestInit];
    expect((init.headers as Record<string, string>)['If-Match']).toBe('"5"');
  });

  test('omits If-Match when expectedVersion is not given', async () => {
    const adapter = await openAdapter();
    mockFetch.mockResolvedValueOnce(jsonResponse(RECORD_RAW));
    await adapter.patchContent('rec-abc123', { text: 'x' });
    const [, init] = mockFetch.mock.lastCall as [string, RequestInit];
    expect((init.headers as Record<string, string>)['If-Match']).toBeUndefined();
  });
});

// -------------------------------------------------------
// commitMigration
// -------------------------------------------------------

describe('commitMigration', () => {
  test('sends POST /records/:id/migrate with toTypeId and content', async () => {
    const adapter = await openAdapter();
    const migrated = { ...RECORD_RAW, typeId: 'com.example/note@2', version: 2 };
    mockFetch.mockResolvedValueOnce(jsonResponse(migrated));
    await adapter.commitMigration('rec-abc123', 'com.example/note@2', { text: 'Hello world' });
    expect(mockFetch).toHaveBeenLastCalledWith(
      `${BASE_URL}/records/rec-abc123/migrate`,
      expect.objectContaining({ method: 'POST' }),
    );
    const [, init] = mockFetch.mock.lastCall as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({
      toTypeId: 'com.example/note@2',
      content: { text: 'Hello world' },
    });
  });

  test('returns the migrated record', async () => {
    const adapter = await openAdapter();
    const migrated = { ...RECORD_RAW, typeId: 'com.example/note@2', version: 2 };
    mockFetch.mockResolvedValueOnce(jsonResponse(migrated));
    const result = await adapter.commitMigration('rec-abc123', 'com.example/note@2', {});
    expect(result.typeId).toBe('com.example/note@2');
  });

  test('sends If-Match when expectedVersion is given', async () => {
    const adapter = await openAdapter();
    mockFetch.mockResolvedValueOnce(jsonResponse(RECORD_RAW));
    await adapter.commitMigration('rec-abc123', 'com.example/note@2', {}, { expectedVersion: 5 });
    const [, init] = mockFetch.mock.lastCall as [string, RequestInit];
    expect((init.headers as Record<string, string>)['If-Match']).toBe('"5"');
  });

  test('omits If-Match when expectedVersion is not given', async () => {
    const adapter = await openAdapter();
    mockFetch.mockResolvedValueOnce(jsonResponse(RECORD_RAW));
    await adapter.commitMigration('rec-abc123', 'com.example/note@2', {});
    const [, init] = mockFetch.mock.lastCall as [string, RequestInit];
    expect((init.headers as Record<string, string>)['If-Match']).toBeUndefined();
  });
});

// -------------------------------------------------------
// setPermissions
// -------------------------------------------------------

describe('setPermissions', () => {
  test('sends PUT /records/:id/permissions with a permissions envelope', async () => {
    const adapter = await openAdapter();
    mockFetch.mockResolvedValueOnce(jsonResponse(RECORD_RAW));
    const updated = await adapter.setPermissions('rec-abc123', [{ access: 'public' }]);
    expect(updated.id).toBe('rec-abc123');
    expect(mockFetch).toHaveBeenLastCalledWith(
      `${BASE_URL}/records/rec-abc123/permissions`,
      expect.objectContaining({ method: 'PUT' }),
    );
    const [, init] = mockFetch.mock.lastCall as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ permissions: [{ access: 'public' }] });
  });
});

// -------------------------------------------------------
// deleteRecord
// -------------------------------------------------------

describe('deleteRecord', () => {
  test('sends DELETE /records/:id for soft delete', async () => {
    const adapter = await openAdapter();
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ ...RECORD_RAW, version: 2, deletedAt: '2024-06-16T12:00:00.000Z' }),
    );
    const deleted = await adapter.deleteRecord('rec-abc123');
    expect(mockFetch).toHaveBeenLastCalledWith(
      `${BASE_URL}/records/rec-abc123`,
      expect.objectContaining({ method: 'DELETE' }),
    );
    expect(deleted?.deletedAt).toBeInstanceOf(Date);
  });

  test('a hard delete has no record to answer with', async () => {
    const adapter = await openAdapter();
    mockFetch.mockResolvedValueOnce(noContent());
    await expect(adapter.deleteRecord('rec-abc123', { hard: true })).resolves.toBeNull();
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
// undeleteRecord
// -------------------------------------------------------

describe('undeleteRecord', () => {
  test('sends POST /records/:id/undelete', async () => {
    const adapter = await openAdapter();
    mockFetch.mockResolvedValueOnce(jsonResponse(RECORD_RAW));
    await adapter.undeleteRecord('rec-abc123');
    expect(mockFetch).toHaveBeenLastCalledWith(
      `${BASE_URL}/records/rec-abc123/undelete`,
      expect.objectContaining({ method: 'POST' }),
    );
  });

  test('returns the record with parsed dates', async () => {
    const adapter = await openAdapter();
    mockFetch.mockResolvedValueOnce(jsonResponse(RECORD_RAW));
    const result = await adapter.undeleteRecord('rec-abc123');
    expect(result.id).toBe('rec-abc123');
    expect(result.createdAt).toBeInstanceOf(Date);
    expect(result.deletedAt).toBeUndefined();
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

  test('uses POST /records/query when the server reaches content', async () => {
    const adapter = await openAdapter();
    mockFetch.mockResolvedValueOnce(jsonResponse(queryEnvelope));
    await adapter.queryRecords({ filter: { typeId: 'com.example/note@1' } });
    expect(mockFetch).toHaveBeenLastCalledWith(
      `${BASE_URL}/records/query`,
      expect.objectContaining({ method: 'POST' }),
    );
  });

  test('uses GET /records when the server reaches no content', async () => {
    const adapter = await openAdapter(discoveryWith({ filter: { content: 'none' } }));
    mockFetch.mockResolvedValueOnce(jsonResponse(queryEnvelope));
    await adapter.queryRecords({ filter: { typeId: 'com.example/note@1' } });
    const [url, init] = mockFetch.mock.lastCall as [string, RequestInit];
    expect(init.method).toBe('GET');
    expect(url).toContain('/records');
    expect(url).toContain('typeId=com.example%2Fnote%401');
  });

  test('parses records and cursor from response, and never reports a total', async () => {
    const adapter = await openAdapter();
    mockFetch.mockResolvedValueOnce(jsonResponse({ ...queryEnvelope, cursor: 'page2', total: 10 }));
    const result = await adapter.queryRecords({});
    expect(result.records).toHaveLength(1);
    expect(result.records[0].createdAt).toBeInstanceOf(Date);
    expect(result.cursor).toBe('page2');
    // Every wire response has passed a permission boundary, so a count
    // ignoring pagination reports records the requester can't read. A
    // server MUST NOT send one; this adapter discards it if one arrives.
    expect(result.total).toBeNull();
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
    const adapter = await openAdapter(discoveryWith({ filter: { content: 'none' } }));
    mockFetch.mockResolvedValueOnce(jsonResponse(queryEnvelope));
    await adapter.queryRecords({ filter: { parentId: null } });
    const [url] = mockFetch.mock.lastCall as [string];
    expect(url).toContain('parentId=null');
  });

  test('GET params carry a content sort as ?sortContent=, not ?sort=', async () => {
    const adapter = await openAdapter(discoveryWith({ filter: { content: 'none' } }));
    mockFetch.mockResolvedValueOnce(jsonResponse(queryEnvelope));
    await adapter.queryRecords({ sort: { contentField: 'publishedAt', direction: 'asc' } });
    const [url] = mockFetch.mock.lastCall as [string];
    expect(url).toContain('sortContent=publishedAt');
    expect(url).toContain('direction=asc');
    expect(url).not.toContain('sort=publishedAt');
  });

  test('GET params include relatedToLabel alongside relatedTo', async () => {
    const adapter = await openAdapter(discoveryWith({ filter: { content: 'none' } }));
    mockFetch.mockResolvedValueOnce(jsonResponse(queryEnvelope));
    await adapter.queryRecords({
      filter: { relatedTo: { label: 'author', target: { scope: 'record', recordId: 'rec-1' } } },
    });
    const [url] = mockFetch.mock.lastCall as [string];
    expect(url).toContain('relatedTo=rec-1');
    expect(url).toContain('relatedToLabel=author');
  });

  test('GET params omit relatedToLabel when no label is given', async () => {
    const adapter = await openAdapter(discoveryWith({ filter: { content: 'none' } }));
    mockFetch.mockResolvedValueOnce(jsonResponse(queryEnvelope));
    await adapter.queryRecords({
      filter: { relatedTo: { target: { scope: 'record', recordId: 'rec-1' } } },
    });
    const [url] = mockFetch.mock.lastCall as [string];
    expect(url).toContain('relatedTo=rec-1');
    expect(url).not.toContain('relatedToLabel');
  });

  // A malformed relationship filter is a caller error, not a missing
  // capability, so it travels as StackQueryError — and is refused before a
  // request the server would only have to reject goes out.
  test('refuses a relatedTo naming neither a label nor a target without sending', async () => {
    const adapter = await openAdapter();
    await expect(adapter.queryRecords({ filter: { relatedTo: {} as never } })).rejects.toThrow(
      StackQueryError,
    );
    expect(mockFetch).toHaveBeenCalledTimes(1); // only the discovery call — no request sent
  });

  test('refuses an empty stackUrl rather than encoding relatedToStack=', async () => {
    const adapter = await openAdapter();
    await expect(
      adapter.queryRecords({
        filter: { relatedTo: { target: { scope: 'record', recordId: 'rec-1', stackUrl: '' } } },
      }),
    ).rejects.toThrow(StackQueryError);
    expect(mockFetch).toHaveBeenCalledTimes(1); // only the discovery call — no request sent
  });

  test("throws APIAdapterCapabilityError for filter.content against reach 'none'", async () => {
    const adapter = await openAdapter(discoveryWith({ filter: { content: 'none' } }));
    await expect(adapter.queryRecords({ filter: { content: { slug: 'hello' } } })).rejects.toThrow(
      APIAdapterCapabilityError,
    );
    expect(mockFetch).toHaveBeenCalledTimes(1); // only the discovery call — no request sent
  });

  test("throws APIAdapterCapabilityError for a nested path against reach 'field'", async () => {
    const adapter = await openAdapter(discoveryWith({ filter: { content: 'field' } }));
    // A single-segment key is still served by the 'field' rung.
    mockFetch.mockResolvedValueOnce(jsonResponse(queryEnvelope));
    await expect(
      adapter.queryRecords({ filter: { content: { slug: 'hello' } } }),
    ).resolves.toBeDefined();
    await expect(
      adapter.queryRecords({ filter: { content: { 'emails.value': 'a@b.c' } } }),
    ).rejects.toThrow(APIAdapterCapabilityError);
  });

  // Silence is not a claim — and an absent sort.fields must refuse a
  // stated sort as the declared-capability error, rather than reading
  // through undefined and raising a TypeError no caller can act on.
  test('a server omitting capabilities entirely is treated as having none', async () => {
    const { capabilities: _drop, ...discovery } = DISCOVERY;
    const adapter = await openAdapter(discovery);

    expect(adapter.capabilities).toEqual({
      filter: { content: 'none', contentPresent: false, search: false },
      sort: { fields: [], contentField: false },
      limits: { attachmentBytes: null, contentBytes: null },
    });

    await expect(adapter.queryRecords({ sort: { field: 'createdAt' } })).rejects.toThrow(
      APIAdapterCapabilityError,
    );
    // A query naming no sort asks for the server's own default order, so it
    // claims nothing and still runs.
    mockFetch.mockResolvedValueOnce(jsonResponse(queryEnvelope));
    await expect(adapter.queryRecords({})).resolves.toBeDefined();
  });

  // A rung this client has never heard of places nowhere on the ladder, so
  // it can only be read as the bottom of it: refusing a query is
  // recoverable, presenting an unfiltered superset as a filtered result is
  // not.
  test('a server declaring a reach this client does not know is treated as having none', async () => {
    const adapter = await openAdapter({
      ...DISCOVERY,
      capabilities: { ...DISCOVERY.capabilities, filter: { content: 'galaxy-brain' } },
    });

    expect(adapter.capabilities.filter.content).toBe('none');
    await expect(adapter.queryRecords({ filter: { content: { slug: 'x' } } })).rejects.toThrow(
      APIAdapterCapabilityError,
    );
  });

  // A malformed path is the caller's error, not the server's missing
  // reach, so it must not be reported as an absent capability.
  test.each([
    ["at reach 'path'", 'path'],
    ["at reach 'field'", 'field'],
  ] as const)('a malformed content path stays a StackQueryError %s', async (_label, reach) => {
    const adapter = await openAdapter(discoveryWith({ filter: { content: reach } }));
    await expect(adapter.queryRecords({ filter: { content: { 'a..b': 1 } } })).rejects.toThrow(
      StackQueryError,
    );
    await expect(adapter.queryRecords({ filter: { content: { 'a..b': 1 } } })).rejects.not.toThrow(
      APIAdapterCapabilityError,
    );
  });

  test('throws APIAdapterCapabilityError for contentPresent without the capability', async () => {
    const adapter = await openAdapter(discoveryWith({ filter: { contentPresent: false } }));
    await expect(
      adapter.queryRecords({ filter: { contentPresent: ['publishedAt'] } }),
    ).rejects.toThrow(APIAdapterCapabilityError);
    expect(mockFetch).toHaveBeenCalledTimes(1); // only the discovery call — no request sent
  });

  test('throws APIAdapterCapabilityError for a content sort without sort.contentField', async () => {
    const adapter = await openAdapter(discoveryWith({ sort: { contentField: false } }));
    await expect(adapter.queryRecords({ sort: { contentField: 'publishedAt' } })).rejects.toThrow(
      APIAdapterCapabilityError,
    );
    expect(mockFetch).toHaveBeenCalledTimes(1); // only the discovery call — no request sent
  });

  test('throws APIAdapterCapabilityError for a native field outside sort.fields', async () => {
    const adapter = await openAdapter(discoveryWith({ sort: { fields: ['createdAt'] } }));
    await expect(adapter.queryRecords({ sort: { field: 'version' } })).rejects.toThrow(
      APIAdapterCapabilityError,
    );
  });

  // The reported capability must be the one the query actually asked for.
  // An unconditional sort.fields check would blame the absent field for a
  // failure the search filter caused, against every server whose discovery
  // omits sort.fields.
  test('names the capability the query asked for, not an unrelated absent sort field', async () => {
    const adapter = await openAdapter({
      ...DISCOVERY,
      capabilities: {
        ...DISCOVERY.capabilities,
        filter: { ...DISCOVERY.capabilities.filter, search: false },
        sort: { contentField: true },
      },
    });
    expect(adapter.capabilities.sort.fields).toEqual([]);
    await expect(adapter.queryRecords({ filter: { search: 'hello' } })).rejects.toMatchObject({
      capability: 'filter.search',
    });
  });

  test('throws APIAdapterCapabilityError for filter.search without the capability', async () => {
    const adapter = await openAdapter(discoveryWith({ filter: { search: false } }));
    await expect(adapter.queryRecords({ filter: { search: 'hello' } })).rejects.toThrow(
      APIAdapterCapabilityError,
    );
    expect(mockFetch).toHaveBeenCalledTimes(1); // only the discovery call — no request sent
  });

  test('does not throw for filter.content when the server reaches content', async () => {
    const adapter = await openAdapter();
    mockFetch.mockResolvedValueOnce(jsonResponse(queryEnvelope));
    await expect(
      adapter.queryRecords({ filter: { content: { slug: 'hello' } } }),
    ).resolves.toBeDefined();
  });
});

// -------------------------------------------------------
// associate / dissociate
// -------------------------------------------------------

describe('associate', () => {
  test('sends POST /records/:id/associations', async () => {
    const adapter = await openAdapter();
    mockFetch.mockResolvedValueOnce(jsonResponse(RECORD_RAW));
    const assoc: Association = { kind: 'tag', label: 'starred' };
    await adapter.associate('rec-abc123', assoc);
    expect(mockFetch).toHaveBeenLastCalledWith(
      `${BASE_URL}/records/rec-abc123/associations`,
      expect.objectContaining({ method: 'POST' }),
    );
  });

  test('sends the association as JSON body', async () => {
    const adapter = await openAdapter();
    mockFetch.mockResolvedValueOnce(jsonResponse(RECORD_RAW));
    const assoc: Association = { kind: 'tag', label: 'starred' };
    await adapter.associate('rec-abc123', assoc);
    const [, init] = mockFetch.mock.lastCall as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual(assoc);
  });
});

describe('dissociate', () => {
  // POST, not DELETE — a DELETE body has no defined wire semantics.
  test('sends POST /records/:id/associations/delete', async () => {
    const adapter = await openAdapter();
    mockFetch.mockResolvedValueOnce(jsonResponse(RECORD_RAW));
    const assoc: Association = { kind: 'tag', label: 'starred' };
    await adapter.dissociate('rec-abc123', assoc);
    expect(mockFetch).toHaveBeenLastCalledWith(
      `${BASE_URL}/records/rec-abc123/associations/delete`,
      expect.objectContaining({ method: 'POST' }),
    );
  });

  test('sends the association as JSON body', async () => {
    const adapter = await openAdapter();
    mockFetch.mockResolvedValueOnce(jsonResponse(RECORD_RAW));
    const assoc: Association = { kind: 'tag', label: 'starred' };
    await adapter.dissociate('rec-abc123', assoc);
    const [, init] = mockFetch.mock.lastCall as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual(assoc);
  });
});

// -------------------------------------------------------
// Foreign servers on the version-bumping mutations
// -------------------------------------------------------

describe('a mutation that bumps a version must answer with a Record', () => {
  const ASSOC: Association = {
    kind: 'relationship',
    label: 'author',
    target: { scope: 'record', recordId: 'rec-other' },
  };

  test('associate reports an empty body as a protocol error', async () => {
    const adapter = await openAdapter();
    mockFetch.mockResolvedValueOnce(noContent());
    const thrown = await adapter.associate('rec-abc123', ASSOC).catch((err: unknown) => err);
    expect(thrown).toBeInstanceOf(APIAdapterError);
    // The endpoint is named, so a foreign server's gap is identifiable.
    expect((thrown as Error).message).toContain('POST /records/rec-abc123/associations');
  });

  test('dissociate reports an empty body as a protocol error', async () => {
    const adapter = await openAdapter();
    mockFetch.mockResolvedValueOnce(noContent());
    await expect(adapter.dissociate('rec-abc123', ASSOC)).rejects.toThrow(APIAdapterError);
  });

  test('setPermissions reports an empty body as a protocol error', async () => {
    const adapter = await openAdapter();
    mockFetch.mockResolvedValueOnce(noContent());
    await expect(adapter.setPermissions('rec-abc123', [{ access: 'public' }])).rejects.toThrow(
      APIAdapterError,
    );
  });

  test('a soft delete reports an empty body as a protocol error', async () => {
    const adapter = await openAdapter();
    mockFetch.mockResolvedValueOnce(noContent());
    await expect(adapter.deleteRecord('rec-abc123')).rejects.toThrow(APIAdapterError);
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
    expect(versions[0].typeId).toBe('com.example/note@1');
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

  test('parses associations and permissions when present', async () => {
    const adapter = await openAdapter();
    const withOptionals = {
      ...VERSION_RAW,
      associations: [{ kind: 'tag', label: 'starred' }],
      permissions: [{ access: 'public' }],
    };
    mockFetch.mockResolvedValueOnce(jsonResponse(withOptionals));
    const version = await adapter.getVersion('rec-abc123', 1);
    expect(version?.associations).toEqual([{ kind: 'tag', label: 'starred' }]);
    expect(version?.permissions).toEqual([{ access: 'public' }]);
  });
});

describe('restoreVersion', () => {
  test('sends POST /records/:id/restore/:version', async () => {
    const adapter = await openAdapter();
    const restored = { ...RECORD_RAW, content: { text: 'original' }, version: 2 };
    mockFetch.mockResolvedValueOnce(jsonResponse(restored));
    await adapter.restoreVersion('rec-abc123', 1);
    expect(mockFetch).toHaveBeenLastCalledWith(
      `${BASE_URL}/records/rec-abc123/restore/1`,
      expect.objectContaining({ method: 'POST' }),
    );
  });

  test('returns the restored record with parsed dates', async () => {
    const adapter = await openAdapter();
    const restored = { ...RECORD_RAW, content: { text: 'original' }, version: 2 };
    mockFetch.mockResolvedValueOnce(jsonResponse(restored));
    const result = await adapter.restoreVersion('rec-abc123', 1);
    expect(result.content).toEqual({ text: 'original' });
    expect(result.createdAt).toBeInstanceOf(Date);
  });
});

describe('saveVersion', () => {
  test('is a no-op — does not make any HTTP requests', async () => {
    const adapter = await openAdapter();
    const callsBefore = mockFetch.mock.calls.length;
    const v: RecordVersion = {
      version: 1,
      typeId: 'com.example/note@1',
      content: { text: 'v1' },
      updatedAt: new Date(),
    };
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

// POST /attachments always creates the _attachment@1 record now —
// the response is a full WireRecord, not { fileId }.
const attachmentRecordResponse = (overrides: Partial<Record<string, unknown>> = {}) => ({
  id: 'rec-attachment-1',
  typeId: '_attachment@1',
  createdAt: '2024-01-01T00:00:00.000Z',
  updatedAt: '2024-01-01T00:00:00.000Z',
  content: { fileId: 'file-xyz', mimeType: 'application/octet-stream', size: 4 },
  version: 1,
  ...overrides,
});

describe('putAttachment', () => {
  // Bytes-only upload has no wire mode: POST /attachments always creates
  // the _attachment@1 record, so implementing this method would
  // silently mint a default-mimeType record while claiming "no record
  // created". It must throw — without ever reaching the network — rather
  // than approximately honor the contract.
  test('throws APIAdapterError and never issues a request', async () => {
    const adapter = await openAdapter();
    mockFetch.mockClear();
    const data = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    await expect(adapter.putAttachment(data)).rejects.toThrow(APIAdapterError);
    await expect(adapter.putAttachment(data)).rejects.toThrow(/not supported over the wire/);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('putAttachmentWithMetadata', () => {
  test('sends POST /attachments with the given Content-Type and Content-Disposition, returns the parsed record', async () => {
    const adapter = await openAdapter();
    mockFetch.mockResolvedValueOnce(
      jsonResponse(
        attachmentRecordResponse({
          content: { fileId: 'file-xyz', mimeType: 'image/png', size: 4, filename: 'photo.png' },
        }),
      ),
    );
    const data = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const record = await adapter.putAttachmentWithMetadata(data, 'image/png', 'photo.png');

    expect(record.id).toBe('rec-attachment-1');
    expect(record.content).toMatchObject({ fileId: 'file-xyz', mimeType: 'image/png' });

    const [url, init] = mockFetch.mock.lastCall as [string, RequestInit];
    expect(url).toBe(`${BASE_URL}/attachments`);
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('image/png');
    expect(headers['Content-Disposition']).toBe("attachment; filename*=UTF-8''photo.png");
  });

  test('omits Content-Disposition when no filename is given', async () => {
    const adapter = await openAdapter();
    mockFetch.mockResolvedValueOnce(jsonResponse(attachmentRecordResponse()));
    await adapter.putAttachmentWithMetadata(new Uint8Array([1]), 'application/octet-stream');

    const [, init] = mockFetch.mock.lastCall as [string, RequestInit];
    expect((init.headers as Record<string, string>)['Content-Disposition']).toBeUndefined();
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

// -------------------------------------------------------
// Error taxonomy reconstruction
// -------------------------------------------------------

describe('error taxonomy reconstruction', () => {
  test('reconstructs StackPermissionError from a 403 wire error body', async () => {
    const adapter = await openAdapter();
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ error: { code: 'permission', message: 'Permission denied' } }, 403),
    );
    await expect(adapter.patchContent('rec-1', { title: 'x' })).rejects.toThrow(
      StackPermissionError,
    );
  });

  test('reconstructs StackNotFoundError from a 404 wire error body', async () => {
    const adapter = await openAdapter();
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ error: { code: 'not_found', message: 'Record "rec-1" not found.' } }, 404),
    );
    await expect(adapter.patchContent('rec-1', { title: 'x' })).rejects.toThrow(StackNotFoundError);
  });

  test('reconstructs StackConflictError from a 409 wire error body', async () => {
    const adapter = await openAdapter();
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ error: { code: 'conflict', message: 'Record "rec-1" already exists.' } }, 409),
    );
    const record: StackRecord = {
      id: 'rec-1',
      typeId: 'com.example/note@1',
      createdAt: new Date(),
      updatedAt: new Date(),
      content: {},
      version: 1,
    };
    await expect(adapter.createRecord(record)).rejects.toThrow(StackConflictError);
  });

  test('reconstructs StackVersionConflictError from a 412 version_conflict wire error body', async () => {
    const adapter = await openAdapter();
    mockFetch.mockResolvedValueOnce(
      jsonResponse(
        {
          error: {
            code: 'version_conflict',
            message: 'Record "rec-1" is at version 3, expected 2',
            versionConflict: { recordId: 'rec-1', expectedVersion: 2, actualVersion: 3 },
          },
        },
        412,
      ),
    );
    let caught: unknown;
    try {
      await adapter.patchContent('rec-1', { title: 'x' }, { expectedVersion: 2 });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(StackVersionConflictError);
    expect(caught).not.toBeInstanceOf(StackConflictError);
    expect((caught as StackVersionConflictError).recordId).toBe('rec-1');
    expect((caught as StackVersionConflictError).expectedVersion).toBe(2);
    expect((caught as StackVersionConflictError).actualVersion).toBe(3);
  });

  test('reconstructs StackVersionConflictError from a bare 412 status with no parseable body', async () => {
    // 412 maps 1:1 to version_conflict (unlike 409, which stays generic
    // 'conflict') — status-only reconstruction recovers the precise type
    // even without a body, from a foreign server or a body-stripping proxy.
    const adapter = await openAdapter();
    mockFetch.mockResolvedValueOnce(new Response('not json', { status: 412 }));
    await expect(
      adapter.patchContent('rec-1', { title: 'x' }, { expectedVersion: 2 }),
    ).rejects.toThrow(StackVersionConflictError);
  });

  test('reconstructs StackPayloadTooLargeError from a 413 payload_too_large wire error body', async () => {
    const adapter = await openAdapter();
    mockFetch.mockResolvedValueOnce(
      jsonResponse(
        {
          error: { code: 'payload_too_large', message: 'Attachment exceeds the server size limit' },
        },
        413,
      ),
    );
    await expect(
      adapter.putAttachmentWithMetadata(new Uint8Array([1, 2, 3]), 'image/png'),
    ).rejects.toThrow(StackPayloadTooLargeError);
  });

  test('reconstructs StackPayloadTooLargeError from a bare 413 status with no parseable body', async () => {
    // 413 is unambiguous — no other wire code shares it — so status-only
    // reconstruction recovers the precise type even without a body, e.g. a
    // reverse proxy's own request-entity-too-large page in front of the
    // server rather than the server's own JSON error body.
    const adapter = await openAdapter();
    mockFetch.mockResolvedValueOnce(new Response('too large', { status: 413 }));
    await expect(
      adapter.putAttachmentWithMetadata(new Uint8Array([1, 2, 3]), 'image/png'),
    ).rejects.toThrow(StackPayloadTooLargeError);
  });

  test('reconstructs StackValidationError from a 422 wire error body, preserving details as .errors', async () => {
    const adapter = await openAdapter();
    mockFetch.mockResolvedValueOnce(
      jsonResponse(
        {
          error: {
            code: 'validation',
            message: 'Content validation failed',
            details: [{ path: 'title', message: 'expected string, got number' }],
          },
        },
        422,
      ),
    );
    let caught: unknown;
    try {
      await adapter.patchContent('rec-1', { title: 42 });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(StackValidationError);
    expect((caught as StackValidationError).errors).toEqual([
      { path: 'title', message: 'expected string, got number' },
    ]);
  });

  test('reconstructs StackQueryError from a 400 wire error body', async () => {
    const adapter = await openAdapter();
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ error: { code: 'bad_request', message: 'Invalid cursor' } }, 400),
    );
    await expect(adapter.queryRecords({ cursor: 'garbage' })).rejects.toThrow(StackQueryError);
  });

  test('falls back to status-based reconstruction when the body is not a wire error', async () => {
    const adapter = await openAdapter();
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 403 }));
    await expect(adapter.patchContent('rec-1', { title: 'x' })).rejects.toThrow(
      StackPermissionError,
    );
  });

  test('falls back to generic APIAdapterError for a status with no unambiguous code', async () => {
    const adapter = await openAdapter();
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 418 }));
    await expect(adapter.patchContent('rec-1', { title: 'x' })).rejects.toThrow(APIAdapterError);
  });

  test('does not reconstruct StackMigrationError from a bare 500 status', async () => {
    const adapter = await openAdapter();
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 500 }));
    let caught: unknown;
    try {
      await adapter.patchContent('rec-1', { title: 'x' });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(APIAdapterError);
    expect(caught).not.toBeInstanceOf(StackMigrationError);
  });

  test('reconstructs StackMigrationError from an explicit 500 wire error body', async () => {
    const adapter = await openAdapter();
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ error: { code: 'migration', message: 'Migration graph corrupted' } }, 500),
    );
    await expect(adapter.patchContent('rec-1', { title: 'x' })).rejects.toThrow(
      StackMigrationError,
    );
  });
});
