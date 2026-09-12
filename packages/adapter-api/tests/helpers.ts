/**
 * The scaffolding every adapter-api test file needs: a stubbed `fetch`, the
 * server it answers as, and the Response shapes those answers take. What a
 * file's server does differently — advertise a change feed, reach no
 * content, speak a protocol version this client refuses — is composed from
 * these pieces rather than respelled, so a fixture that differs differs
 * deliberately.
 */
import { afterEach, beforeEach, vi } from 'vitest';
import { WIRE_PROTOCOL_VERSION } from '@haverstack/wire-types';
import type { DiscoveryCapabilities } from '@haverstack/wire-types';
import { discoveryFixtures } from '@haverstack/conformance-fixtures';
import { APIAdapter } from '../src/index.js';
import type { APIAdapterOpenOptions } from '../src/index.js';

export const BASE_URL = 'https://stack.example.com';
export const TOKEN = 'test-token-abc';
export const OWNER = 'entity-owner-123';

/**
 * A server declaring every capability it has one to declare.
 * `limits.contentBytes` is deliberately absent: a server declaring one
 * limit and not the other is the case the null default exists for.
 */
export const FULL_CAPABILITIES = {
  filter: { content: 'path', contentPresent: true, search: true },
  sort: { fields: ['createdAt', 'updatedAt', 'version'], contentField: true },
  limits: { attachmentBytes: 52428800 },
} satisfies DiscoveryCapabilities;

/**
 * The change feed, which discovery advertises beside `capabilities` rather
 * than in it. Read from the conformance fixture rather than spelled here,
 * so the feed these tests open against is the one the spec publishes — the
 * limited feed `change-feed` uses comes from its sibling fixture the same
 * way.
 */
export const CHANGE_FEED = discoveryFixtures.find(
  (f) => f.name === 'discovery-advertises-a-change-feed',
)!.responseBody!.changes;

/**
 * Discovery from a fully capable server, and no change feed — a file that
 * needs one spreads CHANGE_FEED in, which is also what makes the
 * no-feed case something a test can spell by leaving it out.
 */
export const DISCOVERY = {
  version: WIRE_PROTOCOL_VERSION,
  entityId: OWNER,
  timezone: 'America/New_York',
  capabilities: FULL_CAPABILITIES,
};

export const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

/** What a mutation bumping no version answers with: no body to parse. */
export const noContent = (): Response => new Response(null, { status: 204 });

/**
 * A `200` carrying nothing — the shape the wire format never allows, and
 * the one a foreign server most easily answers by accident.
 */
export const emptyOk = (): Response =>
  new Response('', { status: 200, headers: { 'Content-Type': 'application/json' } });

/**
 * A `200` carrying something that is not this server's JSON: a proxy's
 * error page or a captive-portal redirect that got past `res.ok`.
 */
export const nonJsonResponse = (
  body = '<html><body>502 Bad Gateway</body></html>',
  status = 200,
): Response => new Response(body, { status, headers: { 'Content-Type': 'text/html' } });

/**
 * The stubbed global `fetch` for the test now running. Exported as a live
 * binding, so an importing file sees each test's fresh mock rather than
 * whichever one existed when the module loaded.
 */
export let mockFetch: ReturnType<typeof vi.fn>;

/** Install a fresh `fetch` stub around every test in the calling file. */
export function useFetchMock(): void {
  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });
}

/** Open an adapter — consumes the first fetch call for discovery. */
export const openAdapter = async (
  discovery: object = DISCOVERY,
  opts: Partial<APIAdapterOpenOptions> = {},
): Promise<APIAdapter> => {
  mockFetch.mockResolvedValueOnce(jsonResponse(discovery));
  return APIAdapter.open({ url: BASE_URL, token: TOKEN, ...opts });
};
