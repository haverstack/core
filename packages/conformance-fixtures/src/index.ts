/**
 * Stack — API Conformance Fixtures
 * -------------------------------------------------------
 * Request/response pairs for every record-mutation endpoint in the Stack
 * API wire format (docs/spec/wire-format.md). These pin down
 * the exact wire shape each endpoint accepts and returns — in particular,
 * that PATCH /records/:id carries a content-only merge patch, never
 * record fields like typeId/version/updatedAt.
 *
 * This package is pure data: no test framework, no adapter, no server.
 * Two independent consumers exercise the same fixtures against their own
 * implementation:
 *
 *  - @haverstack/adapter-api tests that APIAdapter produces the documented
 *    request for each method call and parses the documented response.
 *  - haverstack/server (or any other server implementation) tests that its
 *    HTTP handlers accept the documented request and produce the documented
 *    response.
 *
 * A fixture is self-contained: `responseBody` reflects the state that
 * results from applying `requestBody` to whatever prior state the fixture's
 * description assumes. Fixtures don't prescribe how a server seeds that
 * prior state — that's the consumer's test setup.
 */

import type {
  WireRecord,
  WireQueryResponse,
  WireError,
  WireVersion,
  WireRecordChange,
  WireReadyFrame,
  WireResetFrame,
  DiscoveryResponse,
  AuthChallengeRequest,
  AuthChallengeResponse,
  AuthTokenRequest,
  AuthTokenResponse,
  WireAuthError,
} from '@haverstack/wire-types';
import { WIRE_PROTOCOL_VERSION } from '@haverstack/wire-types';

export type WireMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

export type ConformanceFixture<Req = unknown, Res = unknown> = {
  /** Unique, stable name — usable as a test-case id. */
  name: string;
  /** What this fixture pins down, and why. */
  description: string;
  method: WireMethod;
  /** Request path, e.g. "/records/1hk153x00001/restore/1". */
  path: string;
  /** Request headers this call must send, beyond Authorization (omitted throughout — every fixture assumes a valid bearer token unless its description says otherwise). Absent when the endpoint has none, e.g. If-Match for the ifVersion precondition. */
  requestHeaders?: Record<string, string>;
  /** JSON request body. Absent for bodiless requests. */
  requestBody?: Req;
  /** Expected HTTP status code. */
  responseStatus: number;
  /** Expected JSON response body. Absent for empty (e.g. 204, or a bodyless 401) responses. */
  responseBody?: Res;
};

/**
 * Two or more requests whose *order* is the thing being pinned — where the
 * obligation is that a server changed state, not that it produced a shape.
 *
 * A single request/response pair cannot express "and not a second time",
 * so a server can satisfy every fixture above while being replayable. That
 * is the gap this exists for, and it is a narrow one: reach for a plain
 * ConformanceFixture unless a step's expected response depends on an
 * earlier step having happened.
 *
 * Steps are ordinary fixtures applied in order against one server, each
 * seeing the state the previous left. Nothing is templated between them —
 * a step that repeats an earlier one repeats it byte for byte, which is
 * what makes a replay fixture a replay rather than a differently-shaped
 * request.
 */
export type ConformanceSequenceFixture = {
  /** Unique, stable name — usable as a test-case id. */
  name: string;
  /** What this sequence pins down, why order matters, and any assumed prior state. */
  description: string;
  steps: ConformanceFixture[];
};

// -------------------------------------------------------
// Discovery
// -------------------------------------------------------

export const discoveryFixtures: ConformanceFixture<undefined, DiscoveryResponse>[] = [
  {
    name: 'discovery-declares-protocol-version-and-capabilities',
    description:
      'GET /.well-known/stack declares the wire protocol version, the owner DID, and the ' +
      "capability set a client uses to gate queries. `version` is the protocol's version, not " +
      "the server's software version, and a client refuses a server whose major differs from " +
      'its own — see docs/spec/wire-format.md § Version negotiation.',
    method: 'GET',
    path: '/.well-known/stack',
    responseStatus: 200,
    responseBody: {
      version: WIRE_PROTOCOL_VERSION,
      entityId: 'did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK',
      timezone: 'America/New_York',
      capabilities: {
        fullTextSearch: true,
        contentFieldQuery: true,
        nestedContentQuery: true,
        contentFieldSort: true,
        sortableFields: ['createdAt', 'updatedAt', 'version'],
        maxAttachmentBytes: 52428800,
        maxContentBytes: 1048576,
      },
    },
  },
  {
    name: 'discovery-omits-absent-timezone',
    description:
      'A stack with no timezone omits the field rather than defaulting it. An absent timezone ' +
      'stays undefined end to end — a default would assert knowledge the stack was never ' +
      'given (docs/spec.md § The _config record).',
    method: 'GET',
    path: '/.well-known/stack',
    responseStatus: 200,
    responseBody: {
      version: WIRE_PROTOCOL_VERSION,
      entityId: 'did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK',
      capabilities: {
        fullTextSearch: false,
        contentFieldQuery: false,
        nestedContentQuery: false,
        contentFieldSort: false,
        sortableFields: ['createdAt'],
        maxAttachmentBytes: null,
        maxContentBytes: null,
      },
    },
  },
  {
    name: 'discovery-advertises-did-challenge-auth',
    description:
      'A server implementing the challenge–response handshake says so in discovery, so a client ' +
      'holding a DID credential learns at open() whether there is anything to perform rather ' +
      'than finding out as a 404 partway through one. `auth` is optional and its absence means ' +
      'only whatever issuance scheme was arranged out of band. An object rather than a boolean ' +
      'because issuance is the surface most likely to grow another entry — see ' +
      'docs/spec/wire-format.md § Authentication.',
    method: 'GET',
    path: '/.well-known/stack',
    responseStatus: 200,
    responseBody: {
      version: WIRE_PROTOCOL_VERSION,
      entityId: 'did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK',
      capabilities: {
        fullTextSearch: true,
        contentFieldQuery: true,
        nestedContentQuery: true,
        contentFieldSort: true,
        sortableFields: ['createdAt', 'updatedAt', 'version'],
        maxAttachmentBytes: 52428800,
        maxContentBytes: 1048576,
      },
      auth: { methods: ['did-challenge'] },
    },
  },
  {
    name: 'discovery-advertises-a-change-feed',
    description:
      'A server offering a change feed says so as its own top-level object, so a client learns ' +
      'at open() whether there is a feed to connect to rather than as a 404 partway through a ' +
      'connection. `transports` lists what it speaks, `resume` whether a cursor is honored, and ' +
      '`records` whether ?include=record is. An object rather than a boolean because the ' +
      'surface grows entries — see docs/spec/change-feed.md.',
    method: 'GET',
    path: '/.well-known/stack',
    responseStatus: 200,
    responseBody: {
      version: WIRE_PROTOCOL_VERSION,
      entityId: 'did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK',
      capabilities: {
        fullTextSearch: true,
        contentFieldQuery: true,
        nestedContentQuery: true,
        contentFieldSort: true,
        sortableFields: ['createdAt', 'updatedAt', 'version'],
        maxAttachmentBytes: 52428800,
        maxContentBytes: 1048576,
      },
      auth: { methods: ['did-challenge'] },
      changes: { transports: ['sse'], resume: true, records: true },
    },
  },
  {
    name: 'discovery-advertises-a-feed-that-neither-resumes-nor-includes-records',
    description:
      'Both flags false is fully conformant: such a server answers every connection with a ' +
      'reset frame and never honors ?include=record. A client that treats either as required ' +
      'refuses a server this spec permits — the fetch fallback is the contract for the record, ' +
      'and reconciling by query is the contract for the gap.',
    method: 'GET',
    path: '/.well-known/stack',
    responseStatus: 200,
    responseBody: {
      version: WIRE_PROTOCOL_VERSION,
      entityId: 'did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK',
      capabilities: {
        fullTextSearch: false,
        contentFieldQuery: false,
        nestedContentQuery: false,
        contentFieldSort: false,
        sortableFields: ['createdAt'],
        maxAttachmentBytes: null,
        maxContentBytes: null,
      },
      changes: { transports: ['sse'], resume: false, records: false },
    },
  },
];

// -------------------------------------------------------
// Records: create
// -------------------------------------------------------

export const createRecordFixtures: ConformanceFixture<WireRecord, WireRecord>[] = [
  {
    name: 'create-record',
    description: 'POST /records accepts a full record body and echoes it back.',
    method: 'POST',
    path: '/records',
    requestBody: {
      id: '1hk153x00001',
      typeId: 'com.example/note@1',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
      content: { title: 'Hello', body: 'World' },
      version: 1,
    },
    responseStatus: 200,
    responseBody: {
      id: '1hk153x00001',
      typeId: 'com.example/note@1',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
      content: { title: 'Hello', body: 'World' },
      version: 1,
    },
  },
  {
    name: 'create-record-unlisted',
    description:
      'A create body carrying unlistedAt is honoured verbatim — creating a record already ' +
      'unlisted, so there is no window where it exists and is enumerable before a later ' +
      'PUT .../unlisted catches up. Excluded from an unfiltered GET/POST /records/query and the ' +
      'change feed by default, the same as any other unlisted record. See ' +
      'docs/spec/unlisted.md.',
    method: 'POST',
    path: '/records',
    requestBody: {
      id: '1hk153x00009',
      typeId: 'com.example/note@1',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
      content: { title: 'Link-shared draft' },
      version: 1,
      unlistedAt: '2024-01-01T00:00:00.000Z',
    },
    responseStatus: 200,
    responseBody: {
      id: '1hk153x00009',
      typeId: 'com.example/note@1',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
      content: { title: 'Link-shared draft' },
      version: 1,
      unlistedAt: '2024-01-01T00:00:00.000Z',
    },
  },
  {
    name: 'create-record-ignores-client-supplied-entity-and-principal',
    description:
      'entityId and principalId are assigned by the server from the authenticated session, so a ' +
      'body carrying them is ignored rather than honoured — here the session is an undelegated ' +
      'contributor, so the response names that contributor as author and omits principalId ' +
      'entirely, discarding both values the client sent. These are the two fields that answer ' +
      '"who did this", and principalId exists to be the one a client cannot assert: honouring ' +
      'it would let any requester dress a write up as a verified app action and defeat the _app ' +
      'cross-check that reads it. updatedBy and updatedVia answer the same question about the ' +
      'mutation rather than the record, so they are assigned and ignored on the same terms. ' +
      'appId is the deliberate exception, self-reported by design. ' +
      'See docs/spec/wire-format.md § Records.',
    method: 'POST',
    path: '/records',
    requestBody: {
      id: '1hk153x00002',
      typeId: 'com.example/note@1',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
      content: { title: 'Forged', body: 'World' },
      version: 1,
      entityId: 'did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK',
      principalId: 'did:key:z6MkfNotesAppKeyClaimedByTheClient00000000000000',
      updatedBy: 'did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK',
      updatedVia: 'did:key:z6MkfNotesAppKeyClaimedByTheClient00000000000000',
      appId: 'com.example.myapp',
    },
    responseStatus: 200,
    responseBody: {
      id: '1hk153x00002',
      typeId: 'com.example/note@1',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
      content: { title: 'Forged', body: 'World' },
      version: 1,
      entityId: 'entity-contributor-789',
      updatedBy: 'entity-contributor-789',
      appId: 'com.example.myapp',
    },
  },
  {
    name: 'create-record-response-carries-principal-under-delegation',
    description:
      'A write made by a delegated app comes back with entityId naming the subject it acted for ' +
      'and principalId naming the app that authenticated — the pair a reader needs to tell ' +
      'verified app attribution from a bare appId self-report. An undelegated write omits ' +
      'principalId (see create-record above), so its presence is itself the signal. ' +
      'See docs/spec/identity.md § Attribution and what can be trusted.',
    method: 'POST',
    path: '/records',
    requestBody: {
      id: '1hk153x00003',
      typeId: 'com.example/comment@1',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
      content: { body: 'Posted through a blog server' },
      version: 1,
      appId: 'com.example.blog',
    },
    responseStatus: 200,
    responseBody: {
      id: '1hk153x00003',
      typeId: 'com.example/comment@1',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
      content: { body: 'Posted through a blog server' },
      version: 1,
      entityId: 'entity-contributor-789',
      principalId: 'did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK',
      updatedBy: 'entity-contributor-789',
      updatedVia: 'did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK',
      appId: 'com.example.blog',
    },
  },
  {
    name: 'create-attachment-record-matching-mimetype-succeeds',
    description:
      'mimeType is a property of the fileId, established by the first _attachment@1 ' +
      'record ever created for it. A second upload of the same bytes that declares a matching ' +
      'mimeType succeeds and gets its own record — its own id, entityId, and filename — rather ' +
      'than being deduplicated away. Assumes the requester is the owner (generic ' +
      'POST /records for _attachment@1 is owner-only — see ' +
      'error-permission-denied-attachment-non-owner-create and ' +
      'create-attachment-record-non-owner-carve-out-succeeds for the non-owner cases) and that ' +
      'an _attachment@1 record already exists for "fileId": "933f0f80dc48c9e7d885c2f665caca88a709dbbba35e93a17c2cc30ebb963f0d" with ' +
      '"mimeType": "image/png".',
    method: 'POST',
    path: '/records',
    requestBody: {
      id: '1hk153x03004',
      typeId: '_attachment@1',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
      content: {
        fileId: '933f0f80dc48c9e7d885c2f665caca88a709dbbba35e93a17c2cc30ebb963f0d',
        mimeType: 'image/png',
        size: 12345,
        filename: 'second.png',
      },
      version: 1,
    },
    responseStatus: 200,
    responseBody: {
      id: '1hk153x03004',
      typeId: '_attachment@1',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
      content: {
        fileId: '933f0f80dc48c9e7d885c2f665caca88a709dbbba35e93a17c2cc30ebb963f0d',
        mimeType: 'image/png',
        size: 12345,
        filename: 'second.png',
      },
      version: 1,
    },
  },
  {
    name: 'create-attachment-record-non-owner-carve-out-succeeds',
    description:
      'A non-owner who can already read some record referencing ' +
      'fileId "933f0f80dc48c9e7d885c2f665caca88a709dbbba35e93a17c2cc30ebb963f0d" may create an additional _attachment@1 record for it — e.g. their own ' +
      'filename — without re-uploading bytes, since this conveys no access they did not already ' +
      'have. Assumes a record readable by this requester already carries an attachment ' +
      'association or file-ref field for "fileId": "933f0f80dc48c9e7d885c2f665caca88a709dbbba35e93a17c2cc30ebb963f0d". The carve-out is satisfied only ' +
      "by that readable reference, never by the requester's own prior _attachment@1 record for " +
      'the same fileId — see create-attachment-record-non-owner-without-carve-out-refused.',
    method: 'POST',
    path: '/records',
    requestBody: {
      id: '1hk153x05006',
      typeId: '_attachment@1',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
      content: {
        fileId: '933f0f80dc48c9e7d885c2f665caca88a709dbbba35e93a17c2cc30ebb963f0d',
        mimeType: 'image/png',
        size: 12345,
        filename: 'mine.png',
      },
      version: 1,
    },
    responseStatus: 200,
    responseBody: {
      id: '1hk153x05006',
      typeId: '_attachment@1',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
      content: {
        fileId: '933f0f80dc48c9e7d885c2f665caca88a709dbbba35e93a17c2cc30ebb963f0d',
        mimeType: 'image/png',
        size: 12345,
        filename: 'mine.png',
      },
      version: 1,
    },
  },
];

// -------------------------------------------------------
// Records: query — POST /records/query, GET /records
// -------------------------------------------------------
//
// What these pin is the *envelope*, not the filtering: `total` is never a
// number, and `cursor` — not `records.length` — is what says whether the
// result set is exhausted. Both are rules a server can satisfy by
// accident on a small test Stack and violate the moment a requester with
// partial visibility pages through a large one.

export const queryRecordsFixtures: ConformanceFixture<
  Record<string, unknown>,
  WireQueryResponse
>[] = [
  {
    name: 'query-reports-null-total',
    description:
      'The query envelope reports total: null. Every request a server serves is authenticated ' +
      'as some requester, so a count that ignores pagination would report how many Records ' +
      'exist beyond what that requester may read — the cardinality the permission check just ' +
      'hid. A server MUST NOT populate this field on any response, and APIAdapter discards a ' +
      'number if one arrives anyway. See docs/spec/wire-format.md § Response envelope.',
    method: 'POST',
    path: '/records/query',
    requestBody: { filter: { typeId: 'com.example/note@1' }, limit: 2 },
    responseStatus: 200,
    responseBody: {
      records: [
        {
          id: '1hk153x00010',
          typeId: 'com.example/note@1',
          createdAt: '2024-01-01T00:00:00.000Z',
          updatedAt: '2024-01-01T00:00:00.000Z',
          content: { title: 'Readable' },
          version: 1,
        },
      ],
      cursor: null,
      total: null,
    },
  },
  {
    name: 'query-empty-page-with-live-cursor',
    description:
      'An empty records array with a non-null cursor is a valid response and does NOT mean the ' +
      'result set is exhausted — the server filtered a bounded window of stored Records against ' +
      "the requester's permissions and none of them were readable. A requester with little " +
      'visibility into a large Stack can receive several of these in a row before results ' +
      'appear. cursor: null is the only end-of-results signal; a client that stops paging on an ' +
      'empty page silently truncates its own results. See docs/spec/data-model.md § Sorting and ' +
      'pagination.',
    method: 'POST',
    path: '/records/query',
    requestBody: { filter: { typeId: 'com.example/note@1' }, limit: 2 },
    responseStatus: 200,
    responseBody: {
      records: [],
      cursor: 'eyJjcmVhdGVkQXQiOjE3MDQwNjcyMDAwMDAsImlkIjoiMWhrMTUzeDAwMDIwIn0',
      total: null,
    },
  },
  {
    name: 'query-final-page-closes-the-cursor',
    description:
      'The page that exhausts the result set reports cursor: null, whether or not it carried ' +
      'any records. This is the fixture above resumed: the same query, now with the cursor that ' +
      'page handed back, reaching the end of the scan.',
    method: 'POST',
    path: '/records/query',
    requestBody: {
      filter: { typeId: 'com.example/note@1' },
      limit: 2,
      cursor: 'eyJjcmVhdGVkQXQiOjE3MDQwNjcyMDAwMDAsImlkIjoiMWhrMTUzeDAwMDIwIn0',
    },
    responseStatus: 200,
    responseBody: {
      records: [
        {
          id: '1hk153x00021',
          typeId: 'com.example/note@1',
          createdAt: '2024-01-02T00:00:00.000Z',
          updatedAt: '2024-01-02T00:00:00.000Z',
          content: { title: 'Finally visible' },
          version: 1,
        },
      ],
      cursor: null,
      total: null,
    },
  },
  {
    name: 'query-get-records-uses-the-same-envelope',
    description:
      'GET /records — the native-field query endpoint a server without contentFieldQuery ' +
      'exposes — returns the identical envelope, including the same total and cursor rules. ' +
      'The two endpoints differ in what they can filter by, not in what they return.',
    method: 'GET',
    path: '/records?typeId=com.example%2Fnote%401&limit=2',
    responseStatus: 200,
    responseBody: {
      records: [],
      cursor: 'eyJjcmVhdGVkQXQiOjE3MDQwNjcyMDAwMDAsImlkIjoiMWhrMTUzeDAwMDIwIn0',
      total: null,
    },
  },
  {
    name: 'query-related-to-record-target',
    description:
      'A relationship filter naming a Record in this Stack travels as relatedTo, with ' +
      "relatedToStack carrying another Stack's URL when the target has one. An absent " +
      'relatedToStack means this Stack — it is not a wildcard, so a server MUST NOT match a ' +
      'target that carries a stackUrl. This Stack is named that one way: a server MUST ' +
      'reject an empty relatedToStack with 400 rather than read it as local or as a ' +
      'wildcard, and likewise an empty relatedToId, which omission already expresses as the ' +
      'whole namespace. ' +
      'See docs/spec/wire-format.md § Records.',
    method: 'GET',
    path: '/records?relatedTo=1hk153x00001&relatedToLabel=series',
    responseStatus: 200,
    responseBody: { records: [], cursor: null, total: null },
  },
  {
    name: 'query-related-to-entity-target',
    description:
      'A relationship filter naming an identity travels as relatedToEntity, distinct from ' +
      'relatedTo: a DID and a Record id are different reference spaces, and a server that ' +
      'matched one against the other would report group rosters as record references. ' +
      'See docs/spec/wire-format.md § Records.',
    method: 'GET',
    path: '/records?relatedToEntity=did%3Akey%3Az6MkAlice',
    responseStatus: 200,
    responseBody: { records: [], cursor: null, total: null },
  },
  {
    name: 'query-related-to-external-namespace',
    description:
      'A relationship filter naming something outside the Stack travels as relatedToNs plus an ' +
      'optional relatedToId. Omitting relatedToId matches every target in the namespace, which ' +
      'is how a bridge asks what it has already syndicated. A server MUST reject a request ' +
      'mixing parameters from two scopes with 400, and can rely on at least one relatedTo ' +
      'parameter being present whenever the filter is used — the filter never encodes to ' +
      'nothing. See docs/spec/wire-format.md § Records.',
    method: 'GET',
    path: '/records?relatedToNs=atproto',
    responseStatus: 200,
    responseBody: { records: [], cursor: null, total: null },
  },
];

// -------------------------------------------------------
// Records: patchContent — PATCH /records/:id
// -------------------------------------------------------

export const patchContentFixtures: ConformanceFixture<Record<string, unknown>, WireRecord>[] = [
  {
    name: 'patch-record-restamps-the-actor',
    description:
      'A write by someone other than the author moves updatedBy to the requester and leaves ' +
      'entityId alone — the record keeps its author, and gains a record of who last changed ' +
      'it. Under delegation updatedVia names the app alongside it, exactly as principalId does ' +
      'for the create. Both are assigned from the session and ignored on input, like entityId ' +
      'and principalId. See docs/spec/data-model.md § Authorship and attribution.',
    method: 'PATCH',
    path: '/records/1hk153x00001',
    requestBody: { title: 'edited by a contributor' },
    responseStatus: 200,
    responseBody: {
      id: '1hk153x00001',
      typeId: 'com.example/note@1',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-02T00:00:00.000Z',
      content: { title: 'edited by a contributor' },
      version: 2,
      entityId: 'did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK',
      updatedBy: 'entity-contributor-789',
    },
  },
  {
    name: 'patch-content-merges-and-adds-fields',
    description:
      'The PATCH body carries only the content patch — never typeId, version, or updatedAt. ' +
      'The server merges it against current content and assigns the new version/updatedAt itself.',
    method: 'PATCH',
    path: '/records/1hk153x00001',
    requestBody: { title: 'Updated title', pinned: true },
    responseStatus: 200,
    responseBody: {
      id: '1hk153x00001',
      typeId: 'com.example/note@1',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-02T00:00:00.000Z',
      content: { title: 'Updated title', pinned: true, body: 'original body' },
      version: 2,
    },
  },
  {
    name: 'patch-content-null-deletes-a-field',
    description:
      'A field set to null is removed from stored content (RFC 7396 merge-patch delete). ' +
      'Fields omitted from the patch are left untouched.',
    method: 'PATCH',
    path: '/records/1hk153x01002',
    requestBody: { title: null },
    responseStatus: 200,
    responseBody: {
      id: '1hk153x01002',
      typeId: 'com.example/note@1',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-02T00:00:00.000Z',
      content: { body: 'kept' },
      version: 2,
    },
  },
];

// -------------------------------------------------------
// Records: delete / undelete
// -------------------------------------------------------

export const deleteRecordFixtures: ConformanceFixture<undefined, WireRecord | undefined>[] = [
  {
    name: 'delete-record-soft',
    description:
      'DELETE /records/:id soft-deletes — record and version history are retained — and answers ' +
      'with the record it produced, carrying deletedAt and the bumped version. ' +
      'See docs/spec/wire-format.md § Records.',
    method: 'DELETE',
    path: '/records/1hk153x00001',
    responseStatus: 200,
    responseBody: {
      id: '1hk153x00001',
      typeId: 'com.example/note@1',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-02T00:00:00.000Z',
      content: { title: 'Hello', body: 'World' },
      version: 2,
      deletedAt: '2024-01-02T00:00:00.000Z',
    },
  },
  {
    name: 'delete-record-hard',
    description:
      'DELETE /records/:id?hard=true permanently removes the record and its history. The one ' +
      'mutation with no record to answer with: it produces no version, so 204 and no body.',
    method: 'DELETE',
    path: '/records/1hk153x00001?hard=true',
    responseStatus: 204,
  },
];

export const undeleteRecordFixtures: ConformanceFixture<undefined, WireRecord>[] = [
  {
    name: 'undelete-record',
    description:
      'POST /records/:id/undelete reverses a soft delete and returns the record as it now ' +
      'stands (deletedAt absent). Idempotent — a second call returns the same result.',
    method: 'POST',
    path: '/records/1hk153x00001/undelete',
    responseStatus: 200,
    responseBody: {
      id: '1hk153x00001',
      typeId: 'com.example/note@1',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-03T00:00:00.000Z',
      content: { title: 'Hello' },
      version: 3,
    },
  },
];

// -------------------------------------------------------
// Associations
// -------------------------------------------------------

export const associateFixtures: ConformanceFixture<Record<string, unknown>, WireRecord>[] = [
  {
    name: 'associate-tag',
    description:
      'POST /records/:id/associations adds an association and bumps version, answering with the ' +
      'record it produced. See docs/spec/wire-format.md § Records.',
    method: 'POST',
    path: '/records/1hk153x00001/associations',
    requestBody: { kind: 'tag', label: 'starred' },
    responseStatus: 200,
    responseBody: {
      id: '1hk153x00001',
      typeId: 'com.example/note@1',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-02T00:00:00.000Z',
      content: { title: 'Hello', body: 'World' },
      version: 2,
      associations: [{ kind: 'tag', label: 'starred' }],
    },
  },
  {
    name: 'associate-relationship-external-target',
    description:
      'A relationship association carries its target as a discriminated union — the scope names ' +
      'which identifier space the value belongs to, so a server stores and returns it verbatim ' +
      'rather than flattening the arms into one id column. See docs/spec/data-model.md ' +
      '§ Associations.',
    method: 'POST',
    path: '/records/1hk153x00001/associations',
    requestBody: {
      kind: 'relationship',
      label: 'syndicated-to',
      target: { scope: 'external', ns: 'atproto', id: 'at://did:plc:abc/app.bsky.feed.post/3k4' },
    },
    responseStatus: 200,
    responseBody: {
      id: '1hk153x00001',
      typeId: 'com.example/note@1',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-02T00:00:00.000Z',
      content: { title: 'Hello', body: 'World' },
      version: 2,
      associations: [
        {
          kind: 'relationship',
          label: 'syndicated-to',
          target: {
            scope: 'external',
            ns: 'atproto',
            id: 'at://did:plc:abc/app.bsky.feed.post/3k4',
          },
        },
      ],
    },
  },
];

export const dissociateFixtures: ConformanceFixture<Record<string, unknown>, WireRecord>[] = [
  {
    name: 'dissociate-tag',
    description:
      'POST /records/:id/associations/delete removes an association and bumps version, ' +
      'answering with the record it produced — here with associations gone entirely. POST, ' +
      'not DELETE — a DELETE request body has no defined semantics (RFC 9110 §9.3.5) and is a ' +
      'portability landmine for proxies/gateways that drop or reject it.',
    method: 'POST',
    path: '/records/1hk153x00001/associations/delete',
    requestBody: { kind: 'tag', label: 'starred' },
    responseStatus: 200,
    responseBody: {
      id: '1hk153x00001',
      typeId: 'com.example/note@1',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-03T00:00:00.000Z',
      content: { title: 'Hello', body: 'World' },
      version: 3,
    },
  },
];

// -------------------------------------------------------
// Permissions
// -------------------------------------------------------

export const setPermissionsFixtures: ConformanceFixture<{ permissions: unknown[] }, WireRecord>[] =
  [
    {
      name: 'set-permissions-public',
      description:
        'PUT /records/:id/permissions replaces all permissions. The request body uses the ' +
        '{ "permissions": [...] } envelope; the response is the updated Record, since this ' +
        'bumps version like any other mutation. See docs/spec/wire-format.md § Records.',
      method: 'PUT',
      path: '/records/1hk153x00001/permissions',
      requestBody: { permissions: [{ access: 'public' }] },
      responseStatus: 200,
      responseBody: {
        id: '1hk153x00001',
        typeId: 'com.example/note@1',
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-02T00:00:00.000Z',
        content: { title: 'Hello', body: 'World' },
        version: 2,
        permissions: [{ access: 'public' }],
      },
    },
    {
      name: 'set-permissions-empty-is-private',
      description:
        'An empty permissions array makes the record private (owner-only), and the record comes ' +
        'back with no permissions field at all rather than an empty one.',
      method: 'PUT',
      path: '/records/1hk153x00001/permissions',
      requestBody: { permissions: [] },
      responseStatus: 200,
      responseBody: {
        id: '1hk153x00001',
        typeId: 'com.example/note@1',
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-03T00:00:00.000Z',
        content: { title: 'Hello', body: 'World' },
        version: 3,
      },
    },
  ];

// -------------------------------------------------------
// Unlisted
// -------------------------------------------------------

export const setUnlistedFixtures: ConformanceFixture<{ unlisted: boolean }, WireRecord>[] = [
  {
    name: 'set-unlisted-true',
    description:
      'PUT /records/:id/unlisted withholds a record from enumeration without changing who may ' +
      'read it: the response carries unlistedAt and the bumped version, but permissions (if any) ' +
      'are untouched. Orthogonal to PUT .../permissions — see docs/spec/unlisted.md.',
    method: 'PUT',
    path: '/records/1hk153x00001/unlisted',
    requestBody: { unlisted: true },
    responseStatus: 200,
    responseBody: {
      id: '1hk153x00001',
      typeId: 'com.example/note@1',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-02T00:00:00.000Z',
      content: { title: 'Hello', body: 'World' },
      version: 2,
      unlistedAt: '2024-01-02T00:00:00.000Z',
    },
  },
  {
    name: 'set-unlisted-false-relists',
    description:
      'PUT /records/:id/unlisted with { "unlisted": false } reverses it — the record comes back ' +
      'with unlistedAt absent, and is enumerable again by an unfiltered query() and the change ' +
      'feed. Idempotent, like undelete: assumes prior state from set-unlisted-true.',
    method: 'PUT',
    path: '/records/1hk153x00001/unlisted',
    requestBody: { unlisted: false },
    responseStatus: 200,
    responseBody: {
      id: '1hk153x00001',
      typeId: 'com.example/note@1',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-03T00:00:00.000Z',
      content: { title: 'Hello', body: 'World' },
      version: 3,
    },
  },
];

// -------------------------------------------------------
// Versions: read
// -------------------------------------------------------
//
// GET /records/:id/versions[/:version] require mutate-surface
// authorization, not plain read access, and strip snapshot `permissions`
// for non-owners (docs/spec/versioning.md § History access). These pin the
// success shape; the 403 case is error-permission-denied-versions-read-only.

export const getVersionsFixtures: ConformanceFixture<undefined, WireVersion[]>[] = [
  {
    name: 'get-versions-owner-includes-permissions',
    description:
      'GET /records/:id/versions for the stack owner returns every snapshot field verbatim, ' +
      'including permissions.',
    method: 'GET',
    path: '/records/1hk153x00001/versions',
    responseStatus: 200,
    responseBody: [
      {
        version: 1,
        typeId: 'com.example/note@1',
        content: { title: 'original title' },
        updatedAt: '2024-01-01T00:00:00.000Z',
        permissions: [
          { access: 'entity', entityId: 'entity-member-456', read: true, write: false },
        ],
      },
    ],
  },
  {
    name: 'get-versions-non-owner-write-holder-strips-permissions',
    description:
      'GET /records/:id/versions for a non-owner write-holder — who passes the mutate-surface ' +
      'gate above — omits permissions from every returned snapshot. entityId is not stripped, ' +
      'nor are updatedBy/updatedVia: they are the same class of fact as the author a reader ' +
      'already sees on the live record.',
    method: 'GET',
    path: '/records/1hk153x00001/versions',
    responseStatus: 200,
    responseBody: [
      {
        version: 1,
        typeId: 'com.example/note@1',
        content: { title: 'original title' },
        updatedAt: '2024-01-01T00:00:00.000Z',
        entityId: 'entity-contributor-789',
        updatedBy: 'entity-contributor-789',
      },
    ],
  },
];

export const getVersionFixtures: ConformanceFixture<undefined, WireVersion>[] = [
  {
    name: 'get-version-single-strips-permissions-for-non-owner',
    description:
      'GET /records/:id/versions/:version applies the same non-owner permissions-stripping as ' +
      'the list endpoint above, for the single-version fetch.',
    method: 'GET',
    path: '/records/1hk153x00001/versions/1',
    responseStatus: 200,
    responseBody: {
      version: 1,
      typeId: 'com.example/note@1',
      content: { title: 'original title' },
      updatedAt: '2024-01-01T00:00:00.000Z',
    },
  },
];

// -------------------------------------------------------
// Versions: read after migrate/restore
// -------------------------------------------------------
//
// The server is the only snapshot writer (docs/spec/wire-format.md
// § Versions); these pin that a version row appears after POST /migrate
// and POST /restore/:version specifically. A server-side conformance run
// dispatches the mutating fixture first and asserts the version count
// grew; a mocked-transport run can only assert the response shape parses.

export const getVersionsAfterMutateFixtures: ConformanceFixture<undefined, WireVersion[]>[] = [
  {
    name: 'get-versions-after-restore-includes-pre-restore-snapshot',
    description:
      'After restore-version (POST /records/1hk153x00001/restore/1, which moves the record to ' +
      'version 4), GET /records/:id/versions includes a version 3 entry — the restore ' +
      "endpoint's own auto-snapshot of the record's state immediately before restoring — " +
      'alongside the pre-existing version 1 snapshot being restored from.',
    method: 'GET',
    path: '/records/1hk153x00001/versions',
    responseStatus: 200,
    responseBody: [
      {
        version: 3,
        typeId: 'com.example/note@1',
        content: { title: 'title before restore' },
        updatedAt: '2024-01-04T00:00:00.000Z',
      },
      {
        version: 1,
        typeId: 'com.example/note@1',
        content: { title: 'original title' },
        updatedAt: '2024-01-01T00:00:00.000Z',
      },
    ],
  },
  {
    name: 'get-versions-after-migrate-includes-pre-migration-snapshot',
    description:
      'After commit-migration (POST /records/1hk153x00001/migrate, which moves the record to ' +
      'version 5), GET /records/:id/versions includes a version 4 entry — the migrate ' +
      "endpoint's own auto-snapshot of the record's pre-migration state, at its pre-migration " +
      'typeId — on top of everything restore-version already produced.',
    method: 'GET',
    path: '/records/1hk153x00001/versions',
    responseStatus: 200,
    responseBody: [
      {
        version: 4,
        typeId: 'com.example/note@1',
        content: { title: 'original title' },
        updatedAt: '2024-01-04T00:00:00.000Z',
      },
      {
        version: 3,
        typeId: 'com.example/note@1',
        content: { title: 'title before restore' },
        updatedAt: '2024-01-04T00:00:00.000Z',
      },
      {
        version: 1,
        typeId: 'com.example/note@1',
        content: { title: 'original title' },
        updatedAt: '2024-01-01T00:00:00.000Z',
      },
    ],
  },
];

// -------------------------------------------------------
// Versions: restore
// -------------------------------------------------------

export const restoreVersionFixtures: ConformanceFixture<undefined, WireRecord>[] = [
  {
    name: 'restore-version',
    description:
      "POST /records/:id/restore/:version creates a new version from an old snapshot's " +
      'content (and associations, if present) — never permissions. No request body: the ' +
      'server holds the snapshot already.',
    method: 'POST',
    path: '/records/1hk153x00001/restore/1',
    responseStatus: 200,
    responseBody: {
      id: '1hk153x00001',
      typeId: 'com.example/note@1',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-04T00:00:00.000Z',
      content: { title: 'original title' },
      version: 4,
    },
  },
];

// -------------------------------------------------------
// Migration commit
// -------------------------------------------------------

export const commitMigrationFixtures: ConformanceFixture<
  { toTypeId: string; content: Record<string, unknown> },
  WireRecord
>[] = [
  {
    name: 'commit-migration',
    description:
      'POST /records/:id/migrate is the only way typeId changes after creation. Body carries ' +
      "the full post-migration content (computed client-side by the type's owning app); the " +
      "server validates it against toTypeId's schema before writing.",
    method: 'POST',
    path: '/records/1hk153x00001/migrate',
    requestBody: { toTypeId: 'com.example/note@2', content: { title: 'Hello', pinned: false } },
    responseStatus: 200,
    responseBody: {
      id: '1hk153x00001',
      typeId: 'com.example/note@2',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-05T00:00:00.000Z',
      content: { title: 'Hello', pinned: false },
      version: 5,
    },
  },
];

// -------------------------------------------------------
// Error responses
// -------------------------------------------------------
//
// Pins the wire error body contract (docs/spec/wire-format.md § Error
// responses): { error: { code, message, details? } }, `code`
// authoritative. Each fixture assumes the state its description names.
// One exception: 401 has no wire error body — it fires before any DID has
// verified, so there's no core error to serialize yet.

export const errorResponseFixtures: ConformanceFixture<unknown, WireError>[] = [
  {
    name: 'error-permission-denied',
    description:
      'A write from a requester who can read the record but holds no write authority over it ' +
      'returns 403 with code "permission" — reconstructed client-side as StackPermissionError. ' +
      'Readability is what earns the 403: a requester who cannot read the record gets 404 ' +
      'instead (error-not-found-record-the-requester-cannot-read).',
    method: 'PATCH',
    path: '/records/1hk153x00001',
    requestBody: { title: 'New title' },
    responseStatus: 403,
    responseBody: { error: { code: 'permission', message: 'Permission denied' } },
  },
  {
    name: 'error-permission-denied-versions-read-only',
    description:
      'GET /records/:id/versions from a requester who can read the record but cannot ' +
      'write it returns 403 / code "permission" — history is the mutation/recovery surface, ' +
      'gated the same as a write, not exposed to plain readers. Same shape for ' +
      'GET /records/:id/versions/:version.',
    method: 'GET',
    path: '/records/1hk153x00001/versions',
    responseStatus: 403,
    responseBody: { error: { code: 'permission', message: 'Permission denied' } },
  },
  {
    name: 'error-permission-denied-includeUnlisted-non-owner',
    description:
      'POST /records/query with filter.includeUnlisted (equally, GET /records?includeUnlisted=true, ' +
      'or ?includeUnlisted=true on GET /changes) from anyone but the stack owner acting as itself ' +
      'returns 403 / code "permission" — enumeration standing rests on nothing but ownership, so ' +
      'no grant or delegation carries it. A server MUST refuse the flag outright rather than ' +
      'silently drop it: a caller that believes it asked for the full picture and silently got ' +
      'the filtered one is worse than one that was told no. See docs/spec/unlisted.md.',
    method: 'POST',
    path: '/records/query',
    requestBody: { filter: { includeUnlisted: true } },
    responseStatus: 403,
    responseBody: { error: { code: 'permission', message: 'Permission denied' } },
  },
  {
    name: 'error-permission-denied-restore-reference-reconveyance',
    description:
      'POST /records/:id/restore/:version from a non-owner ' +
      'write-holder is refused with 403 / code "permission" when the target snapshot carries an ' +
      'attachment association (or file-ref content field) the requester cannot currently attach ' +
      'fresh — restoring must not re-convey access to a file or record the requester can no ' +
      'longer reach today. The owner is exempt; a plain content-only restore by a write-holder ' +
      'still succeeds (see restore-version).',
    method: 'POST',
    path: '/records/1hk153x00001/restore/1',
    responseStatus: 403,
    responseBody: { error: { code: 'permission', message: 'Permission denied' } },
  },
  {
    name: 'error-permission-denied-attachment-non-owner-create',
    description:
      'POST /records creating an _attachment@1 record is refused for any non-owner ' +
      'requester with 403 / code "permission" — even one holding an otherwise-sufficient ' +
      '"create" grant on the type, and even for a fileId nobody has ever uploaded or referenced. ' +
      'This is not the ordinary missing-grant case (see error-permission-denied): _attachment@1 ' +
      'is access-conveying, and generic create() accepts a caller-supplied fileId with no proof ' +
      'it was ever derived from real bytes, unlike POST /attachments (see Attachments), which ' +
      'computes fileId from bytes it just hashed. Non-owners must use POST /attachments instead. ' +
      'Owner requests for the same body succeed (see create-attachment-record-matching-mimetype-' +
      'succeeds, which assumes an owner requester).',
    method: 'POST',
    path: '/records',
    requestBody: {
      id: '1hk153x06007',
      typeId: '_attachment@1',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
      content: {
        fileId: 'd4dc2868d42528f18d9907a239e378564e4106c796f252424a05c9c850089e41',
        mimeType: 'image/png',
        size: 12345,
      },
      version: 1,
    },
    responseStatus: 403,
    responseBody: { error: { code: 'permission', message: 'Permission denied' } },
  },
  {
    name: 'create-attachment-record-non-owner-without-carve-out-refused',
    description:
      'The carve-out (see ' +
      'create-attachment-record-non-owner-carve-out-succeeds) is satisfied only by a readable ' +
      "record referencing the fileId — never by the requester's own prior _attachment@1 record " +
      'for the same fileId (the "uploaded it themselves" clause of the getAttachment() access ' +
      'rule). Allowing that would let one successful guess bootstrap unlimited further metadata ' +
      'records for the same fileId, reintroducing the circularity the refusal closes. Assumes the ' +
      'requester already holds an _attachment@1 record for "fileId": "d56b0d4d2c35d9d856d06702a6cc4482d4fedbea54a083cfb56cf19bea35d94f" (e.g. from a ' +
      'prior putAttachment() upload) but no readable record references it.',
    method: 'POST',
    path: '/records',
    requestBody: {
      id: '1hk153x07008',
      typeId: '_attachment@1',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
      content: {
        fileId: 'd56b0d4d2c35d9d856d06702a6cc4482d4fedbea54a083cfb56cf19bea35d94f',
        mimeType: 'image/png',
        size: 1,
        filename: 'second-name.png',
      },
      version: 1,
    },
    responseStatus: 403,
    responseBody: { error: { code: 'permission', message: 'Permission denied' } },
  },
  {
    name: 'error-not-found',
    description:
      'A write (e.g. PATCH) against a record id that does not exist — deleted or never ' +
      'created — returns 404 with code "not_found", reconstructed as StackNotFoundError. ' +
      '(GET /records/:id is deliberately excluded here: APIAdapter treats a 404 there as ' +
      '"absent", resolving to null rather than throwing — see nullOn404 in getRecord.)',
    method: 'PATCH',
    path: '/records/1hk153x0a00b',
    requestBody: { title: 'New title' },
    responseStatus: 404,
    responseBody: {
      error: { code: 'not_found', message: 'Record "1hk153x0a00b" not found.' },
    },
  },
  {
    name: 'error-not-found-record-the-requester-cannot-read',
    description:
      'The anti-oracle rule, and the one fixture here that pins a *state* rather than a shape: ' +
      'a record that exists but that the requester cannot read answers exactly as a missing one ' +
      'does — 404, code "not_found", and a message naming only the id the client already sent. ' +
      'Record ids encode their creation millisecond and increment within it, so 403 here would ' +
      'confirm a guessed or derived id. 403 is reserved for a requester who can read the record ' +
      '(error-permission-denied). Assumes "1hk153x00001" exists and the requester holds no read ' +
      'access to it. See docs/spec/access-control.md § Errors and information exposure.',
    method: 'PATCH',
    path: '/records/1hk153x00001',
    requestBody: { title: 'New title' },
    responseStatus: 404,
    responseBody: {
      error: { code: 'not_found', message: 'Record "1hk153x00001" not found.' },
    },
  },
  {
    name: 'error-conflict-duplicate-id',
    description:
      'POST /records with a client-supplied id that already exists in the stack returns 409 ' +
      'with code "conflict" — reconstructed as StackConflictError, never a silent overwrite.',
    method: 'POST',
    path: '/records',
    requestBody: {
      id: '1hk153x00001',
      typeId: 'com.example/note@1',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
      content: { title: 'Duplicate' },
      version: 1,
    },
    responseStatus: 409,
    responseBody: { error: { code: 'conflict', message: 'Record "1hk153x00001" already exists.' } },
  },
  {
    name: 'error-validation-failed',
    description:
      'PATCH content that fails the target type schema returns 422 with code "validation" and ' +
      'field-level details — reconstructed as StackValidationError, with `details` populating ' +
      '`.errors`.',
    method: 'PATCH',
    path: '/records/1hk153x00001',
    requestBody: { title: 42 },
    responseStatus: 422,
    responseBody: {
      error: {
        code: 'validation',
        message: 'Content validation failed',
        details: [{ path: 'title', message: 'expected string, got number' }],
      },
    },
  },
  {
    name: 'error-validation-failed-restore',
    description:
      'POST /records/:id/restore/:version against a drifted or corrupted snapshot — content ' +
      'that no longer satisfies the schema of the type it claims — returns 422 with code ' +
      '"validation", identically to a PATCH validation failure. Restore is not a backdoor ' +
      'around schema validation: the snapshot is validated against its own stored ' +
      "typeId, not the record's current one.",
    method: 'POST',
    path: '/records/1hk153x00001/restore/1',
    responseStatus: 422,
    responseBody: {
      error: {
        code: 'validation',
        message: 'Content validation failed',
        details: [{ path: 'title', message: 'expected string, got number' }],
      },
    },
  },
  {
    name: 'error-validation-permission-write-without-read',
    description:
      'PUT /records/:id/permissions carrying an entry with write and no read returns 422 with ' +
      'code "validation". A write-holder reaches the record and its whole history through the ' +
      'mutate surface, so the combination withholds nothing while appearing to — the server ' +
      'refuses it wherever a request body carries permissions, POST /records included. See ' +
      'docs/spec/access-control.md § Write implies read.',
    method: 'PUT',
    path: '/records/1hk153x00001/permissions',
    requestBody: {
      permissions: [{ access: 'entity', entityId: 'did:key:z6MkMember', read: false, write: true }],
    },
    responseStatus: 422,
    responseBody: {
      error: {
        code: 'validation',
        message: 'Content validation failed',
        details: [
          {
            path: 'permissions[0]',
            message:
              'write requires read: a write-holder reaches the record and its history through the mutate surface, so `write: true, read: false` withholds nothing',
          },
        ],
      },
    },
  },
  {
    name: 'error-validation-attachment-mimetype-conflict-on-create',
    description:
      'POST /records creating an _attachment@1 record whose ' +
      'mimeType conflicts with the mimeType already established (by the first-ever record) for ' +
      'the same fileId returns 422 with code "validation" — reconstructed as ' +
      'StackValidationError. A matching mimeType would instead succeed (see ' +
      'create-attachment-record-matching-mimetype-succeeds). The message never names the ' +
      "established mimeType (anti-oracle): stating it would confirm an existing fileId's " +
      'content type to a caller who only guessed the fileId. Assumes the requester is the owner ' +
      '(non-owner POST /records for _attachment@1 is refused outright — see ' +
      'error-permission-denied-attachment-non-owner-create) and that an _attachment@1 record ' +
      'already exists for "fileId": "933f0f80dc48c9e7d885c2f665caca88a709dbbba35e93a17c2cc30ebb963f0d" with "mimeType": "image/png".',
    method: 'POST',
    path: '/records',
    requestBody: {
      id: '1hk153x04005',
      typeId: '_attachment@1',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
      content: {
        fileId: '933f0f80dc48c9e7d885c2f665caca88a709dbbba35e93a17c2cc30ebb963f0d',
        mimeType: 'text/html',
        size: 12345,
      },
      version: 1,
    },
    responseStatus: 422,
    responseBody: {
      error: {
        code: 'validation',
        message: 'Content validation failed',
        details: [
          {
            path: 'mimeType',
            message: 'mimeType conflicts with the mimeType already established for this fileId',
          },
        ],
      },
    },
  },
  {
    name: 'error-validation-attachment-mimetype-immutable-on-update',
    description:
      'PATCH /records/:id against an _attachment@1 record is rejected with 422 / code ' +
      '"validation" if the patch touches mimeType at all — even restating the current value. ' +
      'filename is the only field an _attachment@1 update may change; fileId and size are ' +
      'rejected the same way if the patch would actually change their stored value.',
    method: 'PATCH',
    path: '/records/1hk153x02003',
    requestBody: { mimeType: 'image/jpeg' },
    responseStatus: 422,
    responseBody: {
      error: {
        code: 'validation',
        message: 'Content validation failed',
        details: [
          {
            path: 'mimeType',
            message: 'mimeType is immutable after creation; delete and re-upload to change it',
          },
        ],
      },
    },
  },
  {
    name: 'error-bad-request-malformed-cursor',
    description:
      'A query with an undecodable pagination cursor returns 400 with code "bad_request" — a ' +
      'structurally malformed request, distinct from a 422 content-validation failure. ' +
      'Reconstructed as StackQueryError. "not-a-valid-cursor" is not valid base64 ' +
      "(the hyphens aren't in the alphabet), so decoding fails before the sort-field is ever " +
      'inspected — the message names the malformed input itself, not a sort field. See ' +
      'error-bad-request-unknown-sort-field-cursor for the distinct, decodable-but-invalid case.',
    method: 'POST',
    path: '/records/query',
    requestBody: { cursor: 'not-a-valid-cursor' },
    responseStatus: 400,
    responseBody: {
      error: {
        code: 'bad_request',
        message: 'Invalid cursor: malformed "not-a-valid-cursor"',
      },
    },
  },
  {
    name: 'error-bad-request-unknown-sort-field-cursor',
    description:
      'A cursor that decodes cleanly as base64 but names a sort field the server ' +
      "doesn't recognize is a second, distinct 400 bad_request branch from the malformed-" +
      'base64 case above (see error-bad-request-malformed-cursor) — both map to the same code, ' +
      'but a server that only implements one of the two decode failures is only half-conformant. ' +
      'The cursor here is the base64 encoding of "badfield|123|1hk153x00001".',
    method: 'POST',
    path: '/records/query',
    requestBody: { cursor: 'YmFkZmllbGR8MTIzfDFoazE1M3gwMDAwMQ==' },
    responseStatus: 400,
    responseBody: {
      error: {
        code: 'bad_request',
        message: 'Invalid cursor: unknown sort field "badfield"',
      },
    },
  },

  {
    name: 'error-payload-too-large-record-body',
    description:
      "A record body exceeding the server's request-size limit returns 413 with code " +
      '"payload_too_large" — the same code and class as an oversized attachment upload, since a ' +
      'client acts on both identically. maxAttachmentBytes bounds attachment bytes only: a ' +
      "record body and a PATCH body have no ceiling in core, so this one is the server's to " +
      'set and to state (as maxContentBytes in discovery, letting Stack.create()/update() ' +
      'pre-check rather than burn the round trip). The body below stands in for one that ' +
      'exceeds the limit; the fixture pins the error shape, not a specific size. See ' +
      'docs/spec/wire-format.md § Request size limits.',
    method: 'POST',
    path: '/records',
    requestBody: {
      id: '1hk153x02010',
      typeId: 'com.example/note@1',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
      content: { body: 'a very large document…' },
      version: 1,
    },
    responseStatus: 413,
    responseBody: {
      error: { code: 'payload_too_large', message: 'Request body exceeds the server size limit' },
    },
  },

  {
    name: 'error-reserved-content-key',
    description:
      'A content key of __proto__, constructor or prototype is refused with 422 and code ' +
      '"validation" on POST /records and PATCH /records/:id alike. Undeclared content fields are ' +
      'permitted by design, but these three name JavaScript object machinery rather than fields, ' +
      'and the write paths disagree about them: a merge patch to __proto__ reaches the prototype ' +
      'setter and vanishes, while the same key through create() stores as an ordinary property. ' +
      'A server built on core inherits the refusal through ordinary record validation; one ' +
      'mapping request bodies onto storage directly applies it itself. See ' +
      'docs/spec/data-model.md § Reserved content keys.',
    method: 'PATCH',
    path: '/records/1hk153x02011',
    requestBody: JSON.parse('{"__proto__": {"polluted": true}}') as Record<string, unknown>,
    responseStatus: 422,
    responseBody: {
      error: {
        code: 'validation',
        message: 'Content validation failed',
        details: [
          {
            path: '__proto__',
            message: '"__proto__" is a reserved content key and cannot be used as a field name',
          },
        ],
      },
    },
  },

  {
    name: 'error-timeout-search-exceeds-server-bound',
    description:
      'A full-text search the server abandoned for taking too long returns 503 with code ' +
      '"timeout" — reconstructed as StackTimeoutError. The sanitizers bound a search\'s ' +
      'grammar, not its execution cost, and both SQLite engines run synchronously in-process, ' +
      'so a server under load bounds query time at the boundary where it drives the engine ' +
      '(see docs/spec/wire-format.md § Bounding query cost). The code has to be distinct from ' +
      'bad_request: nothing was applied and the same search may succeed if narrowed or retried, ' +
      'where bad_request tells a client the opposite. A server that bounds nothing never emits ' +
      'this — it is the typed answer for one that does, not an obligation to produce.',
    method: 'POST',
    path: '/records/query',
    requestBody: { filter: { search: 'the OR a OR of OR and' } },
    responseStatus: 503,
    responseBody: {
      error: {
        code: 'timeout',
        message: 'Query exceeded the server time limit',
      },
    },
  },

  {
    name: 'error-version-conflict-if-match-mismatch',
    description:
      'PATCH /records/:id with an If-Match header whose value does not match the ' +
      'record\'s current version returns 412 with code "version_conflict" — reconstructed as ' +
      'StackVersionConflictError. The versionConflict payload (recordId/expectedVersion/' +
      'actualVersion) is exactly what an ifVersion retry loop needs: which record, what it ' +
      'expected, what actually won the race. Deliberately not 409 / "conflict": the two error ' +
      'types have different recovery stories (fix your input vs. re-read and retry) and get ' +
      'distinct statuses so status-only reconstruction (no parseable body) still recovers the ' +
      'precise error. Assumes the record is currently at version 7.',
    method: 'PATCH',
    path: '/records/1hk153x00001',
    requestHeaders: { 'If-Match': '"5"' },
    requestBody: { title: 'New title' },
    responseStatus: 412,
    responseBody: {
      error: {
        code: 'version_conflict',
        message: 'Record "1hk153x00001" is at version 7, expected 5',
        versionConflict: { recordId: '1hk153x00001', expectedVersion: 5, actualVersion: 7 },
      },
    },
  },
  {
    name: 'error-schema-drift-non-additive-redefinition',
    description:
      'POST /types on an id that already has a stored Type runs the same drift check as ' +
      'Stack.defineType(): a schema-hash mismatch is only legal if the change is purely ' +
      'additive (new optional fields, recursively, nothing removed/retyped/newly-required). ' +
      "Changing an existing field's kind is not additive, so this returns 409 with code " +
      '"schema_drift" — reconstructed as StackSchemaDriftError — never a silent REPLACE of the ' +
      'stored definition. The duplicate-id 409 (code "conflict") and this one deliberately share ' +
      'a status but not a code — status-only reconstruction of a bodyless 409 degrades ' +
      'to the generic StackConflictError; only a parseable body recovers this specific class. ' +
      'Assumes "com.example/note@1" is already stored with { title: { kind: "string", ' +
      'required: true } }.',
    method: 'POST',
    path: '/types',
    requestBody: {
      id: 'com.example/note@1',
      baseId: 'com.example/note',
      version: 1,
      name: 'Note',
      schema: { title: { kind: 'number', required: true } },
      schemaHash: 'b2c9f7a1e6d4805c3f19a8e2b7d6c4a1908f5e3d2c1b0a9f8e7d6c5b4a392817',
      createdAt: '2024-01-01T00:00:00.000Z',
    },
    responseStatus: 409,
    responseBody: {
      error: {
        code: 'schema_drift',
        message:
          'Schema drift detected for type "com.example/note@1": the stored schema and the new ' +
          'definition differ beyond additive evolution (new optional fields only). Bump the ' +
          'version instead of redefining "com.example/note@1" in place.',
        schemaDrift: {
          typeId: 'com.example/note@1',
          violations: [{ path: 'title', message: 'field kind changed from "string" to "number"' }],
        },
      },
    },
  },
  {
    name: 'error-bad-request-id-invalid-charset',
    description:
      'POST /records with a client-supplied id containing a character outside ' +
      'lowercase Crockford base-32 (0-9, a-z excluding i/l/o/u) returns 400 with code ' +
      '"bad_request" — structurally malformed input, not a 422 content-validation failure (the ' +
      'id never reaches type-schema validation). Reconstructed as StackQueryError.',
    method: 'POST',
    path: '/records',
    requestBody: {
      id: '1hk153x0000!',
      typeId: 'com.example/note@1',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
      content: { title: 'Hello' },
      version: 1,
    },
    responseStatus: 400,
    responseBody: {
      error: {
        code: 'bad_request',
        message: 'Invalid ID "1hk153x0000!": expected 12 lowercase Crockford base-32 characters.',
      },
    },
  },
  {
    name: 'error-bad-request-id-invalid-length',
    description:
      'POST /records with a client-supplied id that is not exactly 12 characters ' +
      'returns 400 with code "bad_request", the same structural-malformed-input class as the ' +
      'invalid-charset case above.',
    method: 'POST',
    path: '/records',
    requestBody: {
      id: 'short-id',
      typeId: 'com.example/note@1',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
      content: { title: 'Hello' },
      version: 1,
    },
    responseStatus: 400,
    responseBody: {
      error: {
        code: 'bad_request',
        message: 'Invalid ID "short-id": expected 12 lowercase Crockford base-32 characters.',
      },
    },
  },
  {
    name: 'error-bad-request-id-reserved-prefix',
    description:
      'POST /records with a client-supplied id beginning with "_" returns 400 ' +
      'with code "bad_request" — that namespace is reserved for system records (_config, ' +
      '_entity, ...). Checked before the charset/length check (the Crockford alphabet already ' +
      'excludes "_", so a reserved-looking id would otherwise fail as a generic format error ' +
      'instead of this specific, actionable one). The duplicate-id 409 case (error-conflict-' +
      'duplicate-id) is unaffected — this is about ids that were never legal to submit at all.',
    method: 'POST',
    path: '/records',
    requestBody: {
      id: '_hk153x00001',
      typeId: 'com.example/note@1',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
      content: { title: 'Hello' },
      version: 1,
    },
    responseStatus: 400,
    responseBody: {
      error: {
        code: 'bad_request',
        message: 'ID "_hk153x00001" uses the reserved "_" prefix.',
      },
    },
  },
  {
    name: 'error-conflict-delete-config',
    description:
      'DELETE /records/_config — soft or hard — is always refused with 409 / ' +
      'code "conflict": _config holds the stack\'s identity (ownerEntityId, read at open and ' +
      'consulted by every permission check) and deleting it either bricks the stack (hard) or ' +
      'makes it unreadable through normal paths (soft). Reconstructed as StackConflictError.',
    method: 'DELETE',
    path: '/records/_config',
    responseStatus: 409,
    responseBody: {
      error: {
        code: 'conflict',
        message:
          "Cannot delete the _config record: it holds the stack's identity and is required " +
          'for every permission check.',
      },
    },
  },
  {
    name: 'error-conflict-config-entityid-change',
    description:
      'PATCH /records/_config that would change entityId returns 409 / code ' +
      '"conflict" — entityId defines stack ownership, read once at open and consulted by every ' +
      'permission check thereafter; a write that silently re-anchored it would desync every ' +
      'already-running owner check. Other _config fields (e.g. timezone) update normally through ' +
      'the same endpoint — only an entityId change is refused.',
    method: 'PATCH',
    path: '/records/_config',
    requestBody: { entityId: 'did:key:z6MkvVv7EXm3g3XZ8k4hqYqK5zqfSj6pS4KvL5s6cQzYzZq3' },
    responseStatus: 409,
    responseBody: {
      error: {
        code: 'conflict',
        message:
          'Cannot change _config.entityId: it defines stack ownership. Ownership transfer is ' +
          'not a supported operation.',
      },
    },
  },
  {
    name: 'error-unauthorized-anonymous',
    description:
      'A request with no bearer token, or an invalid/expired one, returns 401 ' +
      'with no wire error body at all — there is no verified DID behind the request at all ' +
      '("who are you?"). This is distinct from error-permission-denied\'s 403, which means the ' +
      "requester's DID *did* verify but their permissions/grants don't cover the operation " +
      '("your claim is genuine; no") — a server must keep the two statuses apart, never collapse ' +
      'unverified and verified-but-ungranted into one. Unlike every other code in this file, 401 ' +
      'carries no JSON body: APIAdapter checks response status before ever attempting to parse ' +
      'one, and reconstructs APIAdapterAuthError from status alone.',
    method: 'PATCH',
    path: '/records/1hk153x00001',
    requestBody: { title: 'New title' },
    responseStatus: 401,
  },
];

// -------------------------------------------------------
// Authentication: the challenge–response handshake
// -------------------------------------------------------
//
// The two endpoints that turn key possession into a bearer token
// (docs/spec/wire-format.md § Authentication). Unlike every other fixture
// here, these are unauthenticated by definition — they are how a token is
// obtained in the first place.
//
// The DID, nonce and signature below are real: the signature verifies
// against AUTH_FIXTURE_PAYLOAD, which is what @haverstack/core's
// buildAuthChallengePayload() produces for AUTH_FIXTURE_ORIGIN. A server
// consuming these must serve them from that origin, or the signature will
// correctly fail to verify — origin binding is the point, not an incidental
// detail of the fixture.

/** The origin these fixtures are signed for. A consuming server must present itself as this. */
export const AUTH_FIXTURE_ORIGIN = 'https://stack.example.com';

/** The DID whose key signed the handshake fixtures. */
export const AUTH_FIXTURE_DID = 'did:key:z6Mkfsz9oK6i2355mvEwtDYdAmqCN6kmQETThJtARfj9iGum';

export const AUTH_FIXTURE_NONCE = 'k7Qm2ZxRt9vLbNc4Hy8Wf3';

/** Exactly the bytes signed, as a string — so a consumer can diff against its own construction. */
export const AUTH_FIXTURE_PAYLOAD = `haverstack-auth-v1\n${AUTH_FIXTURE_ORIGIN}\n${AUTH_FIXTURE_DID}\n${AUTH_FIXTURE_NONCE}`;

/** base64url Ed25519 signature over AUTH_FIXTURE_PAYLOAD by AUTH_FIXTURE_DID's key. */
export const AUTH_FIXTURE_SIGNATURE =
  'CIvHvqS75hEpPDZi7hwLFOMM44-UCMuF5HzZ9_OIAMQvsGAYGsvXXpXQTP3KaPH2qKnQxl2j3xcB_v-axIx8Bg';

/** A well-formed signature over the same payload by a *different* key. */
export const AUTH_FIXTURE_FOREIGN_SIGNATURE =
  'qFvrpIE8dSPBO8-4QgFbS8jgs8dIz5XcqmqHX1GzFKrg6EnwNnc9vu2y8K1UHXKIUDo_NJgTj5B4xSGXUotiBg';

/** A second DID, holding its own key — for pinning that a nonce belongs to the DID it was issued for. */
export const AUTH_FIXTURE_OTHER_DID = 'did:key:z6Mktp5FtRqj2M7JxnPz9JWGMCUTE5o3XGt1br11TczKGp7B';

/** AUTH_FIXTURE_OTHER_DID's own valid signature over the same origin and nonce. */
export const AUTH_FIXTURE_OTHER_DID_SIGNATURE =
  'HV-vmd5p9cj6V4HjTUWLt1ySnFpp-hT4P_Lh_JXueTV8D992L4V-oEyL6koGY-kbkMB3ulJTLf7SYfnuXkXZDQ';

export const authChallengeFixtures: ConformanceFixture<
  AuthChallengeRequest,
  AuthChallengeResponse | WireAuthError
>[] = [
  {
    name: 'auth-challenge-issues-nonce',
    description:
      'POST /auth/challenge takes the DID a client wants to prove and returns a nonce bound to ' +
      'it, with the expiry the client can read rather than guess. Sent with no bearer token — ' +
      'this is how one is earned. The nonce is opaque but restricted to base64url characters, ' +
      'since it lands in a newline-delimited signing payload where an unconstrained value could ' +
      'span fields. It must be single-use and bound to the requested DID: a nonce redeemable ' +
      'twice, or with a different DID, is not a proof of anything.',
    method: 'POST',
    path: '/auth/challenge',
    requestBody: { did: AUTH_FIXTURE_DID },
    responseStatus: 200,
    responseBody: { nonce: AUTH_FIXTURE_NONCE, expiresAt: '2024-06-15T12:05:00.000Z' },
  },
  {
    name: 'auth-challenge-rejects-malformed-did',
    description:
      'A `did` that is not a DID at all is 400 / code "invalid_did" — malformed input rather ' +
      'than a rejected credential, since there is nothing here to authenticate yet. Auth codes ' +
      'are their own vocabulary, deliberately outside WireErrorCode: no Stack operation has ' +
      'begun, so none of them maps to a StackError.',
    method: 'POST',
    path: '/auth/challenge',
    requestBody: { did: 'not-a-did' },
    responseStatus: 400,
    responseBody: { error: { code: 'invalid_did', message: 'Not a valid DID' } },
  },
];

export const authTokenFixtures: ConformanceFixture<
  AuthTokenRequest,
  AuthTokenResponse | WireAuthError
>[] = [
  {
    name: 'auth-token-issues-bearer-token',
    description:
      'POST /auth/token redeems a signed nonce for a bearer token. The server verifies the ' +
      'signature against the payload it builds itself — never one supplied by the client — and ' +
      "that payload includes the server's own public origin, which is what stops a signature " +
      'made for one server being redeemed at another. principalId and subjectId are both ' +
      'reported and are equal here: a handshake proves key possession, which says nothing about ' +
      'whom that key may act for, so this endpoint never delegates. The pair is reported anyway ' +
      'so an issuance path that does delegate needs no different shape.',
    method: 'POST',
    path: '/auth/token',
    requestBody: {
      did: AUTH_FIXTURE_DID,
      nonce: AUTH_FIXTURE_NONCE,
      signature: AUTH_FIXTURE_SIGNATURE,
    },
    responseStatus: 200,
    responseBody: {
      token: 'a3f1c8e29b7d4056ab12cd34ef567890a3f1c8e29b7d4056ab12cd34ef567890',
      expiresAt: '2024-06-22T12:00:00.000Z',
      principalId: AUTH_FIXTURE_DID,
      subjectId: AUTH_FIXTURE_DID,
    },
  },
  {
    name: 'auth-token-rejects-foreign-signature',
    description:
      'A well-formed signature made by a key other than the one the DID names is 401 / code ' +
      '"invalid_signature". Fatal rather than retryable: repeating the handshake with the same ' +
      'credential reaches the same answer, so a client must stop rather than loop.',
    method: 'POST',
    path: '/auth/token',
    requestBody: {
      did: AUTH_FIXTURE_DID,
      nonce: AUTH_FIXTURE_NONCE,
      signature: AUTH_FIXTURE_FOREIGN_SIGNATURE,
    },
    responseStatus: 401,
    responseBody: { error: { code: 'invalid_signature', message: 'Signature does not verify' } },
  },
  {
    name: 'auth-token-rejects-expired-nonce',
    description:
      'A nonce past its expiry is 401 / code "expired_nonce". Retryable: the credential is ' +
      'fine and a fresh challenge will succeed, so a client re-runs the handshake once rather ' +
      'than surfacing a failure. Distinguishing this from invalid_signature is the whole reason ' +
      'these carry codes instead of being bodyless 401s like every other endpoint.',
    method: 'POST',
    path: '/auth/token',
    requestBody: {
      did: AUTH_FIXTURE_DID,
      nonce: AUTH_FIXTURE_NONCE,
      signature: AUTH_FIXTURE_SIGNATURE,
    },
    responseStatus: 401,
    responseBody: { error: { code: 'expired_nonce', message: 'Challenge has expired' } },
  },
  {
    name: 'auth-token-rejects-nonce-issued-to-another-did',
    description:
      'A nonce belongs to the DID it was issued for. This redemption is internally consistent — ' +
      'AUTH_FIXTURE_OTHER_DID signed this exact origin and nonce with its own key, so the ' +
      'signature verifies — and must still be refused with 401 / code "unknown_nonce", because ' +
      'the nonce was issued to AUTH_FIXTURE_DID. A server that stores nonces without recording ' +
      'who each was issued to passes every other fixture here and fails this one. Assumes the ' +
      'server has issued AUTH_FIXTURE_NONCE to AUTH_FIXTURE_DID and not yet spent it.',
    method: 'POST',
    path: '/auth/token',
    requestBody: {
      did: AUTH_FIXTURE_OTHER_DID,
      nonce: AUTH_FIXTURE_NONCE,
      signature: AUTH_FIXTURE_OTHER_DID_SIGNATURE,
    },
    responseStatus: 401,
    responseBody: { error: { code: 'unknown_nonce', message: 'Unknown or already-used nonce' } },
  },
  {
    name: 'auth-token-rejects-unknown-nonce',
    description:
      'A nonce the server never issued — or already spent, single use being what keeps a ' +
      'signature from being replayed — is 401 / code "unknown_nonce". Retryable for the same ' +
      'reason as expiry. A server MUST NOT distinguish never-issued from already-spent in the ' +
      'code it returns: the two differ only in what an attacker learns.',
    method: 'POST',
    path: '/auth/token',
    requestBody: {
      did: AUTH_FIXTURE_DID,
      nonce: 'Zz9NeverIssuedNonce00',
      signature: AUTH_FIXTURE_SIGNATURE,
    },
    responseStatus: 401,
    responseBody: { error: { code: 'unknown_nonce', message: 'Unknown or already-used nonce' } },
  },
];

/**
 * Single-use is the one handshake obligation no single request/response
 * pair can express, and it is the one whose absence is invisible: a server
 * that issues nonces, verifies signatures, and never spends them satisfies
 * every fixture above while letting one captured signature be redeemed for
 * as long as the nonce lives.
 */
export const authSequenceFixtures: ConformanceSequenceFixture[] = [
  {
    name: 'auth-nonce-is-single-use',
    description:
      'The same valid redemption sent twice: the first earns a token, the second is refused ' +
      'with 401 / code "unknown_nonce". The two requests are byte-identical — that is what makes ' +
      'this a replay rather than a differently-shaped request — so nothing about the second one ' +
      'distinguishes it except that the first already happened. A server must therefore spend ' +
      'the nonce when it redeems it, not merely check that it exists and has not expired. ' +
      'Assumes the server has issued AUTH_FIXTURE_NONCE to AUTH_FIXTURE_DID and not yet spent ' +
      'it. Note the refusal does not say "already used": never-issued and already-spent are ' +
      'deliberately indistinguishable, since they differ only in what an attacker learns.',
    steps: [
      {
        name: 'auth-nonce-is-single-use-first-redemption',
        description: 'The first redemption of a freshly issued nonce succeeds.',
        method: 'POST',
        path: '/auth/token',
        requestBody: {
          did: AUTH_FIXTURE_DID,
          nonce: AUTH_FIXTURE_NONCE,
          signature: AUTH_FIXTURE_SIGNATURE,
        },
        responseStatus: 200,
        responseBody: {
          token: 'a3f1c8e29b7d4056ab12cd34ef567890a3f1c8e29b7d4056ab12cd34ef567890',
          expiresAt: '2024-06-22T12:00:00.000Z',
          principalId: AUTH_FIXTURE_DID,
          subjectId: AUTH_FIXTURE_DID,
        },
      },
      {
        name: 'auth-nonce-is-single-use-replay-refused',
        description: 'The identical request again, after the nonce has been spent.',
        method: 'POST',
        path: '/auth/token',
        requestBody: {
          did: AUTH_FIXTURE_DID,
          nonce: AUTH_FIXTURE_NONCE,
          signature: AUTH_FIXTURE_SIGNATURE,
        },
        responseStatus: 401,
        responseBody: {
          error: { code: 'unknown_nonce', message: 'Unknown or already-used nonce' },
        },
      },
    ],
  },
];

// -------------------------------------------------------
// Attachment download: dangerous-type forcing
// -------------------------------------------------------
//
// GET /attachments/:fileId pins response *headers*, not a JSON body —
// hence a separate, narrower fixture type. Forcing applies to the
// resolved candidate, never the source, so each fixture pins one
// (source, type) pair (docs/spec/wire-format.md § Download;
// resolveAttachmentDownloadContentType() is the canonical implementation).

export type AttachmentDownloadFixture = {
  /** Unique, stable name — usable as a test-case id. */
  name: string;
  /** What this fixture pins down, and why. Also states any assumed prior state (e.g. an existing _attachment@1 record), since GET takes no body. */
  description: string;
  /** Request path including query string, e.g. "/attachments/933f0f80dc48c9e7d885c2f665caca88a709dbbba35e93a17c2cc30ebb963f0d?contentType=text/html". */
  path: string;
  /** Response headers this GET must produce. Only the headers a fixture pins are listed here; anything else about the response is unconstrained by it. */
  responseHeaders: Record<string, string>;
};

const NOSNIFF = { 'X-Content-Type-Options': 'nosniff' };

export const attachmentDownloadFixtures: AttachmentDownloadFixture[] = [
  {
    name: 'attachment-download-contenttype-param-safe-passes-through',
    description: 'A safe ?contentType is served as given.',
    path: '/attachments/933f0f80dc48c9e7d885c2f665caca88a709dbbba35e93a17c2cc30ebb963f0d?contentType=image/png',
    responseHeaders: { 'Content-Type': 'image/png', ...NOSNIFF },
  },
  {
    name: 'attachment-download-contenttype-param-dangerous-forced',
    description:
      'A dangerous ?contentType is forced to application/octet-stream — the long-covered case, ' +
      'kept here so the full three-source matrix is in one place.',
    path: '/attachments/933f0f80dc48c9e7d885c2f665caca88a709dbbba35e93a17c2cc30ebb963f0d?contentType=text/html',
    responseHeaders: {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': 'attachment',
      ...NOSNIFF,
    },
  },
  {
    name: 'attachment-download-filename-extension-safe-passes-through',
    description:
      'With no ?contentType, a safe type inferred from the ?filename extension is served as given.',
    path: '/attachments/933f0f80dc48c9e7d885c2f665caca88a709dbbba35e93a17c2cc30ebb963f0d?filename=photo.png',
    responseHeaders: { 'Content-Type': 'image/png', ...NOSNIFF },
  },
  {
    name: 'attachment-download-filename-extension-dangerous-forced',
    description:
      'With no ?contentType, a dangerous type inferred from the ?filename extension must ' +
      'still be forced — otherwise `?filename=payload.html` is an unhardened path into the ' +
      'same XSS this policy exists to prevent.',
    path: '/attachments/933f0f80dc48c9e7d885c2f665caca88a709dbbba35e93a17c2cc30ebb963f0d?filename=payload.html',
    responseHeaders: {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': 'attachment',
      ...NOSNIFF,
    },
  },
  {
    name: 'attachment-download-stored-mimetype-safe-passes-through',
    description:
      'With no query params, a safe stored _attachment@1 mimeType is served as given. Assumes ' +
      'an _attachment@1 record exists for "fileId": "933f0f80dc48c9e7d885c2f665caca88a709dbbba35e93a17c2cc30ebb963f0d" with "mimeType": "image/png".',
    path: '/attachments/933f0f80dc48c9e7d885c2f665caca88a709dbbba35e93a17c2cc30ebb963f0d',
    responseHeaders: { 'Content-Type': 'image/png', ...NOSNIFF },
  },
  {
    name: 'attachment-download-stored-mimetype-dangerous-forced',
    description:
      'With no query params, a dangerous stored mimeType must still be forced: a lying ' +
      'or dishonest _attachment@1 record must not reach the response header unforced just ' +
      'because it came from storage rather than a query param. Assumes an _attachment@1 record ' +
      'exists for "fileId": "0c313c16bde1bf6c37ad8f2d64caa1eda306cb566a19f9bf74a94e69ca46a737" with "mimeType": "text/html".',
    path: '/attachments/0c313c16bde1bf6c37ad8f2d64caa1eda306cb566a19f9bf74a94e69ca46a737',
    responseHeaders: {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': 'attachment',
      ...NOSNIFF,
    },
  },
  {
    name: 'attachment-download-no-metadata-defaults-to-octet-stream',
    description:
      'With no query params and no _attachment@1 record for the fileId, the response falls ' +
      'back to application/octet-stream — already the safe default, so unforced in the sense ' +
      'that nothing needed overriding, but nosniff is still present.',
    path: '/attachments/55e6bec88d703985030c5822286b105ead73d7bb8ffa1927a28a69e3acd0ba2a',
    responseHeaders: { 'Content-Type': 'application/octet-stream', ...NOSNIFF },
  },
];

// -------------------------------------------------------
// Attachment upload: POST /attachments creates the record
// -------------------------------------------------------
//
// The request body is raw bytes, so these pin the upload headers going in
// and the created _attachment@1 record coming out — the combined,
// non-owner-safe upload primitive (docs/spec/wire-format.md § Upload).
// See error-permission-denied-attachment-non-owner-create for the
// generic-create path this closes.

export type AttachmentUploadFixture = {
  /** Unique, stable name — usable as a test-case id. */
  name: string;
  /** What this fixture pins down, and why. */
  description: string;
  /** Request headers this POST must send. Authorization is omitted — every fixture here assumes a valid bearer token for the described requester. */
  requestHeaders: Record<string, string>;
  /** Value of the optional `?appId=` query param, which carries attribution a binary body has nowhere to put. Absent when the upload names no app. */
  appId?: string;
  /** Raw request body bytes, as an array of byte values (0-255), so the fixture stays plain data with no binary encoding. */
  requestBodyBytes: number[];
  /** Expected HTTP status code. */
  responseStatus: number;
  /** Expected JSON response body: the created _attachment@1 record, or a WireError. */
  responseBody: WireRecord | WireError;
};

// SHA-256 of the byte sequence below (the ASCII string "hello").
const HELLO_FILE_ID = '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824';
const HELLO_BYTES = [104, 101, 108, 108, 111];

export const attachmentUploadFixtures: AttachmentUploadFixture[] = [
  {
    name: 'attachment-upload-creates-metadata-record',
    description:
      'POST /attachments carries Content-Type and Content-Disposition (filename) and ' +
      'stores the bytes and creates the _attachment@1 record in the same request — the wire ' +
      'counterpart of ScopedStack.putAttachment()/Stack.putAttachment(). The response is the ' +
      'created record (same shape as POST /records), not just { fileId }. fileId is the SHA-256 ' +
      'hex hash of the request body.',
    requestHeaders: {
      'Content-Type': 'text/plain',
      'Content-Disposition': "attachment; filename*=UTF-8''hello.txt",
    },
    requestBodyBytes: HELLO_BYTES,
    responseStatus: 200,
    responseBody: {
      id: '1hk153x08009',
      typeId: '_attachment@1',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
      content: {
        fileId: HELLO_FILE_ID,
        mimeType: 'text/plain',
        size: HELLO_BYTES.length,
        filename: 'hello.txt',
      },
      version: 1,
    },
  },
  {
    name: 'attachment-upload-carries-appid-query-param',
    description:
      'An optional ?appId= query param stamps the writing app onto the created record. It rides ' +
      'the URL because the request body is the raw binary, leaving nowhere for the field that ' +
      'POST /records takes inline — without it, attachments would be the one record kind that ' +
      'cannot carry attribution. Self-reported and never a permission input, like every other ' +
      'appId. See docs/spec/wire-format.md § Upload.',
    requestHeaders: {
      'Content-Type': 'text/plain',
      'Content-Disposition': "attachment; filename*=UTF-8''hello.txt",
    },
    appId: 'com.example.myapp',
    requestBodyBytes: HELLO_BYTES,
    responseStatus: 200,
    responseBody: {
      id: '1hk153x0800a',
      typeId: '_attachment@1',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
      content: {
        fileId: HELLO_FILE_ID,
        mimeType: 'text/plain',
        size: HELLO_BYTES.length,
        filename: 'hello.txt',
      },
      version: 1,
      appId: 'com.example.myapp',
    },
  },
  {
    name: 'attachment-upload-no-content-type-defaults-to-octet-stream',
    description:
      'Content-Type is optional on upload — when omitted, the server defaults the ' +
      "created record's mimeType to application/octet-stream rather than rejecting the request, " +
      'matching the download-side default (see attachment-download-no-metadata-defaults-to-' +
      'octet-stream).',
    requestHeaders: {},
    requestBodyBytes: HELLO_BYTES,
    responseStatus: 200,
    responseBody: {
      id: '1hk153x0900a',
      typeId: '_attachment@1',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
      content: {
        fileId: HELLO_FILE_ID,
        mimeType: 'application/octet-stream',
        size: HELLO_BYTES.length,
      },
      version: 1,
    },
  },
  {
    name: 'attachment-upload-non-owner-without-create-grant-forbidden',
    description:
      'POST /attachments requires the same authorization as creating an _attachment@1 record: ' +
      '403 / code "permission" if the requester lacks a create grant on _attachment@1. Unlike ' +
      'generic POST /records (see error-permission-denied-attachment-non-owner-create), a ' +
      'non-owner *with* a create grant succeeds here — that grant is exactly what makes this the ' +
      'sanctioned non-owner path.',
    requestHeaders: { 'Content-Type': 'text/plain' },
    requestBodyBytes: HELLO_BYTES,
    responseStatus: 403,
    responseBody: { error: { code: 'permission', message: 'Permission denied' } },
  },
  {
    name: 'attachment-upload-payload-too-large',
    description:
      "A body exceeding the server's configured MAX_ATTACHMENT_BYTES ceiling " +
      '(exposed ahead of time as maxAttachmentBytes in discovery — see docs/spec/wire-format.md § Discovery) ' +
      'returns 413 with code "payload_too_large" — reconstructed client-side as ' +
      'StackPayloadTooLargeError. 413 is unambiguous (no other wire code shares it), so this is ' +
      'also recoverable from status alone when the response has no parseable body — e.g. a ' +
      "reverse proxy's own request-entity-too-large page in front of the server. The request " +
      'body below stands in for one that exceeds the ceiling; the fixture pins the error shape, ' +
      'not a specific size.',
    requestHeaders: { 'Content-Type': 'text/plain' },
    requestBodyBytes: HELLO_BYTES,
    responseStatus: 413,
    responseBody: {
      error: { code: 'payload_too_large', message: 'Attachment exceeds the server size limit' },
    },
  },
];

// -------------------------------------------------------
// Change feed
// -------------------------------------------------------
//
// GET /changes pins an ordered stream of SSE frames rather than one JSON
// body, and most of what it must pin is what a *mutation* makes the open
// connection say — hence a fixture type of its own. A frame is recorded as
// its `id:`, `event:` name and parsed `data:`; the SSE encoding around them
// is the transport's, not this spec's.
//
// Every connection below assumes a valid bearer token and Accept:
// text/event-stream, and a server advertising `changes` in discovery. See
// docs/spec/change-feed.md.

/** One SSE frame: `id:` (when the frame is resumable), `event:`, and parsed `data:`. */
export type ChangeFeedFrame = {
  /** SSE `id:`. Present only on frames a cursor can resume from — control frames carry none. */
  id?: string;
  /** SSE `event:` name. A client MUST ignore a name it does not recognize. */
  event: string;
  /** SSE `data:`, as parsed JSON. */
  data: WireRecordChange | WireReadyFrame | WireResetFrame | Record<string, unknown>;
};

/** A mutation applied while the connection is open, and what it must produce there. */
export type ChangeFeedActivity = {
  /** An ordinary request, made by the session its own description names. */
  mutation: ConformanceFixture;
  /** The frames this mutation must produce on the open connection. Empty means none. */
  frames: ChangeFeedFrame[];
};

export type ChangeFeedFixture = {
  /** Unique, stable name — usable as a test-case id. */
  name: string;
  /** What this fixture pins down, and why. Also states the prior state and the session it assumes, since a connection carries no body. */
  description: string;
  /** Request path including query string, e.g. "/changes?typeId=com.example/note@1". */
  path: string;
  /** Headers this connection sends beyond Authorization and Accept — Last-Event-ID when resuming. */
  requestHeaders?: Record<string, string>;
  /** Requests applied before this connection opens. It learns of them only through a cursor, never as live frames. */
  precedingMutations?: ConformanceFixture[];
  responseStatus: number;
  /** Frames delivered on connect, before any mutation below. `ready` always leads. */
  openingFrames: ChangeFeedFrame[];
  /** Mutations applied while the connection is open, in order. */
  activity?: ChangeFeedActivity[];
};

/**
 * Two or more connections whose *order* is the thing being pinned — what a
 * server owes a client that comes back holding a cursor. Steps are applied
 * in order against one server, each opened after the previous has closed.
 */
export type ChangeFeedSequenceFixture = {
  /** Unique, stable name — usable as a test-case id. */
  name: string;
  /** What this sequence pins down, why order matters, and any assumed prior state. */
  description: string;
  steps: ChangeFeedFixture[];
};

const FEED_OWNER = 'did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK';
const FEED_CONTRIBUTOR = 'entity-contributor-789';

/** The head cursor a server reports on connect, before anything has happened. */
const FEED_HEAD_SEQ = 'AA3f1Q';

const READY: ChangeFeedFrame = { event: 'ready', data: { seq: FEED_HEAD_SEQ } };

export const changeFeedFixtures: ChangeFeedFixture[] = [
  {
    name: 'change-feed-ready-leads-every-connection',
    description:
      'A connection is answered with a ready frame before anything else, carrying the head ' +
      'cursor. It is what makes subscribe-then-query gap-free: a client that awaits it before ' +
      'querying knows every later change reaches it as a frame, and the overlap is absorbed by ' +
      'the version comparison it already makes. A server that sends changes before ready leaves ' +
      'every client to discover that race on its own.',
    path: '/changes',
    responseStatus: 200,
    openingFrames: [READY],
  },
  {
    name: 'change-feed-created-frame',
    description:
      'A create produces one frame, kind "created" and op "create", carrying the identity, ' +
      'type and version of what was written plus the actor who wrote it. The envelope has no ' +
      "record provenance in it: `actor` is who performed the change, never the record's author " +
      '— see docs/spec/events.md § Attribution. Here the two coincide, because a create is the ' +
      'one mutation where they do.',
    path: '/changes',
    responseStatus: 200,
    openingFrames: [READY],
    activity: [
      {
        mutation: {
          name: 'change-feed-created-frame-mutation',
          description: 'The owner creates a note.',
          method: 'POST',
          path: '/records',
          requestBody: {
            id: '1hk153x00001',
            typeId: 'com.example/note@1',
            createdAt: '2024-01-01T00:00:00.000Z',
            updatedAt: '2024-01-01T00:00:00.000Z',
            content: { title: 'Hello' },
            version: 1,
          },
          responseStatus: 200,
          responseBody: {
            id: '1hk153x00001',
            typeId: 'com.example/note@1',
            createdAt: '2024-01-01T00:00:00.000Z',
            updatedAt: '2024-01-01T00:00:00.000Z',
            content: { title: 'Hello' },
            version: 1,
            entityId: FEED_OWNER,
          },
        },
        frames: [
          {
            id: 'AA3f1R',
            event: 'record',
            data: {
              kind: 'created',
              op: 'create',
              recordId: '1hk153x00001',
              typeId: 'com.example/note@1',
              version: 1,
              updatedAt: '2024-01-01T00:00:00.000Z',
              actor: { entityId: FEED_OWNER },
            },
          },
        ],
      },
    ],
  },
  {
    name: 'change-feed-changed-frame-names-the-verb',
    description:
      'Seven mutation verbs arrive as kind "changed" — update, associate, dissociate, ' +
      'permissions, migrate, restore and undelete — and `op` is what separates them. A client ' +
      'branching on kind alone is correct and complete; one that needs to tell a reshare from ' +
      'an edit reads op. Both fields are carried because the safe default has to be the easy ' +
      'one: a client wired to three named events would silently miss the other seven verbs. ' +
      'The actor is the contributor who made this write, while the record keeps its own author.',
    path: '/changes',
    responseStatus: 200,
    openingFrames: [READY],
    activity: [
      {
        mutation: {
          name: 'change-feed-changed-frame-mutation',
          description: 'A contributor edits the note.',
          method: 'PATCH',
          path: '/records/1hk153x00001',
          requestBody: { title: 'edited by a contributor' },
          responseStatus: 200,
          responseBody: {
            id: '1hk153x00001',
            typeId: 'com.example/note@1',
            createdAt: '2024-01-01T00:00:00.000Z',
            updatedAt: '2024-01-02T00:00:00.000Z',
            content: { title: 'edited by a contributor' },
            version: 2,
            entityId: FEED_OWNER,
            updatedBy: FEED_CONTRIBUTOR,
          },
        },
        frames: [
          {
            id: 'AA3f1S',
            event: 'record',
            data: {
              kind: 'changed',
              op: 'update',
              recordId: '1hk153x00001',
              typeId: 'com.example/note@1',
              version: 2,
              updatedAt: '2024-01-02T00:00:00.000Z',
              actor: { entityId: FEED_CONTRIBUTOR },
            },
          },
        ],
      },
    ],
  },
  {
    name: 'change-feed-deleted-frame-is-not-terminal',
    description:
      'A soft delete is kind "deleted" and bumps a version like any other mutation, so the ' +
      'record can still be undeleted, restored or read as history. That is what separates it ' +
      'from "purged" below, and why the two are distinct kinds rather than one delete signal: a ' +
      'consumer that drops its history on a soft delete has thrown away recoverable state.',
    path: '/changes',
    responseStatus: 200,
    openingFrames: [READY],
    activity: [
      {
        mutation: {
          name: 'change-feed-deleted-frame-mutation',
          description: 'The owner soft-deletes the note.',
          method: 'DELETE',
          path: '/records/1hk153x00001',
          responseStatus: 200,
          responseBody: {
            id: '1hk153x00001',
            typeId: 'com.example/note@1',
            createdAt: '2024-01-01T00:00:00.000Z',
            updatedAt: '2024-01-03T00:00:00.000Z',
            content: { title: 'Hello' },
            version: 3,
            entityId: FEED_OWNER,
            deletedAt: '2024-01-03T00:00:00.000Z',
          },
        },
        frames: [
          {
            id: 'AA3f1T',
            event: 'record',
            data: {
              kind: 'deleted',
              op: 'delete',
              recordId: '1hk153x00001',
              typeId: 'com.example/note@1',
              version: 3,
              updatedAt: '2024-01-03T00:00:00.000Z',
              actor: { entityId: FEED_OWNER },
            },
          },
        ],
      },
    ],
  },
  {
    name: 'change-feed-unlist-frame-is-a-deleted-kind',
    description:
      'Marking a record unlisted arrives as kind "deleted" / op "unlist" — not "changed" — even ' +
      'though the record still exists and get() still resolves it. A subscriber without ' +
      'includeUnlisted already knows this record from before, and the record’s new state ' +
      '(unlistedAt now set) would otherwise be excluded by the very filter this event announces, ' +
      'so the transition is delivered on the same terms as an ordinary soft delete: the point is ' +
      'telling a subscriber to drop its copy, not that the record is gone. See ' +
      'docs/spec/events.md § The unlisted transition.',
    path: '/changes',
    responseStatus: 200,
    openingFrames: [READY],
    activity: [
      {
        mutation: {
          name: 'change-feed-unlist-frame-mutation',
          description: 'The owner marks the note unlisted.',
          method: 'PUT',
          path: '/records/1hk153x00001/unlisted',
          requestBody: { unlisted: true },
          responseStatus: 200,
          responseBody: {
            id: '1hk153x00001',
            typeId: 'com.example/note@1',
            createdAt: '2024-01-01T00:00:00.000Z',
            updatedAt: '2024-01-03T00:00:00.000Z',
            content: { title: 'Hello' },
            version: 3,
            entityId: FEED_OWNER,
            unlistedAt: '2024-01-03T00:00:00.000Z',
          },
        },
        frames: [
          {
            id: 'AA3f1U',
            event: 'record',
            data: {
              kind: 'deleted',
              op: 'unlist',
              recordId: '1hk153x00001',
              typeId: 'com.example/note@1',
              version: 3,
              updatedAt: '2024-01-03T00:00:00.000Z',
              actor: { entityId: FEED_OWNER },
            },
          },
        ],
      },
    ],
  },
  {
    name: 'change-feed-list-frame-is-a-changed-kind',
    description:
      'Relisting a previously-unlisted record arrives as kind "changed" / op "list" — the ' +
      'publish moment, mechanically identical to an ordinary upsert. A subscriber applies it the ' +
      'same way it applies "undelete": it may never have seen this record before (its earlier ' +
      'create and any edits while unlisted were withheld), and this is the first event that ' +
      'names it. Assumes prior state from change-feed-unlist-frame-is-a-deleted-kind. See ' +
      'docs/spec/events.md § The unlisted transition.',
    path: '/changes',
    responseStatus: 200,
    openingFrames: [READY],
    activity: [
      {
        mutation: {
          name: 'change-feed-list-frame-mutation',
          description: 'The owner relists the note.',
          method: 'PUT',
          path: '/records/1hk153x00001/unlisted',
          requestBody: { unlisted: false },
          responseStatus: 200,
          responseBody: {
            id: '1hk153x00001',
            typeId: 'com.example/note@1',
            createdAt: '2024-01-01T00:00:00.000Z',
            updatedAt: '2024-01-04T00:00:00.000Z',
            content: { title: 'Hello' },
            version: 4,
            entityId: FEED_OWNER,
          },
        },
        frames: [
          {
            id: 'AA3f1V',
            event: 'record',
            data: {
              kind: 'changed',
              op: 'list',
              recordId: '1hk153x00001',
              typeId: 'com.example/note@1',
              version: 4,
              updatedAt: '2024-01-04T00:00:00.000Z',
              actor: { entityId: FEED_OWNER },
            },
          },
        ],
      },
    ],
  },
  {
    name: 'change-feed-unlisted-record-produces-no-frame-by-default',
    description:
      'An edit to a record that is currently unlisted produces no frame at all for a subscriber ' +
      'without includeUnlisted — not an empty or redacted one. This is what makes the feed match ' +
      'an equivalent query(): a record excluded from listings is excluded from the announcement ' +
      'stream too, on every op except the unlist transition itself (see ' +
      'change-feed-unlist-frame-is-a-deleted-kind). Assumes the note was already made unlisted. ' +
      'See docs/spec/events.md § The unlisted transition.',
    path: '/changes',
    responseStatus: 200,
    openingFrames: [READY],
    activity: [
      {
        mutation: {
          name: 'change-feed-unlisted-record-edit-mutation',
          description: 'The owner edits the still-unlisted note.',
          method: 'PATCH',
          path: '/records/1hk153x00001',
          requestBody: { title: 'Edited while unlisted' },
          responseStatus: 200,
          responseBody: {
            id: '1hk153x00001',
            typeId: 'com.example/note@1',
            createdAt: '2024-01-01T00:00:00.000Z',
            updatedAt: '2024-01-04T00:00:00.000Z',
            content: { title: 'Edited while unlisted' },
            version: 4,
            entityId: FEED_OWNER,
            unlistedAt: '2024-01-03T00:00:00.000Z',
          },
        },
        frames: [],
      },
    ],
  },
  {
    name: 'change-feed-purged-frame-carries-nothing-about-the-record',
    description:
      'The rule a server is most likely to break, because it is holding the record at exactly ' +
      'that moment: readability for a purge can only be evaluated before the write, so the ' +
      'record is in hand when the frame is built. It carries kind, op, recordId, typeId, ' +
      'version, updatedAt and actor — no record body even though this connection asked for one, ' +
      'no parentId, and no author. Hard delete is the erasure primitive, and a frame naming ' +
      'what was erased writes a permanent note of it into every subscriber log at the moment ' +
      'the stack finished destroying its own copy. What survives is the useful property: a ' +
      'purge tells a consumer holding the record to forget it, and tells one that never held it ' +
      'nothing. The actor comes from the request, since a hard delete stamps nothing on a ' +
      'record that no longer exists; the verb is owner-only and refuses delegation, so there is ' +
      'never a principal beside it. See docs/spec/events.md § Purged records carry nothing.',
    path: '/changes?include=record',
    responseStatus: 200,
    openingFrames: [READY],
    activity: [
      {
        mutation: {
          name: 'change-feed-purged-frame-mutation',
          description: 'The owner hard-deletes a note that had a parent and an author.',
          method: 'DELETE',
          path: '/records/1hk153x00002?hard=true',
          responseStatus: 204,
        },
        frames: [
          {
            id: 'AA3f1U',
            event: 'record',
            data: {
              kind: 'purged',
              op: 'hard-delete',
              recordId: '1hk153x00002',
              typeId: 'com.example/note@1',
              version: 4,
              updatedAt: '2024-01-04T00:00:00.000Z',
              actor: { entityId: FEED_OWNER },
            },
          },
        ],
      },
    ],
  },
  {
    name: 'change-feed-include-record-carries-the-body',
    description:
      'A connection passing ?include=record against a server advertising records:true gets the ' +
      'record as of the change, so a reactive consumer answers an event without a fetch. It is ' +
      'a bandwidth decision, never an access one: a subscriber who may not read the record ' +
      'receives no frame at all, so there is no case where the envelope is deliverable and the ' +
      'body is not. It stays optional — a server declaring records:false is conformant, and the ' +
      'fallback is a fetch — so a client that assumes presence breaks against half the servers ' +
      'this spec permits.',
    path: '/changes?include=record',
    responseStatus: 200,
    openingFrames: [READY],
    activity: [
      {
        mutation: {
          name: 'change-feed-include-record-mutation',
          description: 'The owner edits the note.',
          method: 'PATCH',
          path: '/records/1hk153x00001',
          requestBody: { title: 'Updated title' },
          responseStatus: 200,
          responseBody: {
            id: '1hk153x00001',
            typeId: 'com.example/note@1',
            createdAt: '2024-01-01T00:00:00.000Z',
            updatedAt: '2024-01-02T00:00:00.000Z',
            content: { title: 'Updated title' },
            version: 2,
            entityId: FEED_OWNER,
            updatedBy: FEED_OWNER,
          },
        },
        frames: [
          {
            id: 'AA3f1V',
            event: 'record',
            data: {
              kind: 'changed',
              op: 'update',
              recordId: '1hk153x00001',
              typeId: 'com.example/note@1',
              version: 2,
              updatedAt: '2024-01-02T00:00:00.000Z',
              actor: { entityId: FEED_OWNER },
              record: {
                id: '1hk153x00001',
                typeId: 'com.example/note@1',
                createdAt: '2024-01-01T00:00:00.000Z',
                updatedAt: '2024-01-02T00:00:00.000Z',
                content: { title: 'Updated title' },
                version: 2,
                entityId: FEED_OWNER,
                updatedBy: FEED_OWNER,
              },
            },
          },
        ],
      },
    ],
  },
  {
    name: 'change-feed-unreadable-record-produces-no-frame',
    description:
      'This connection belongs to a contributor with no grant on 1hk153x09001, a private record ' +
      "of the owner's. The owner edits it, and the contributor receives nothing — not an empty " +
      'frame, not a redacted one. The existence of a change is itself a disclosure: a frame ' +
      'stripped of its content still reports that a record exists and that someone is working ' +
      "on it, which is the same reasoning that keeps a scoped query's total null. The predicate " +
      'is canRead applied per event, so a feed cannot disagree with get() and query() about ' +
      'what this session sees. Assumes the second edit, to a note the contributor may read, so ' +
      'that the fixture distinguishes filtering from a server that simply emits nothing.',
    path: '/changes',
    responseStatus: 200,
    openingFrames: [READY],
    activity: [
      {
        mutation: {
          name: 'change-feed-unreadable-record-mutation',
          description: "The owner edits a private record the connection's session cannot read.",
          method: 'PATCH',
          path: '/records/1hk153x09001',
          requestBody: { title: 'private' },
          responseStatus: 200,
          responseBody: {
            id: '1hk153x09001',
            typeId: 'com.example/note@1',
            createdAt: '2024-01-01T00:00:00.000Z',
            updatedAt: '2024-01-02T00:00:00.000Z',
            content: { title: 'private' },
            version: 2,
            entityId: FEED_OWNER,
            updatedBy: FEED_OWNER,
            permissions: [],
          },
        },
        frames: [],
      },
      {
        mutation: {
          name: 'change-feed-readable-record-mutation',
          description: 'The owner edits a note this session may read.',
          method: 'PATCH',
          path: '/records/1hk153x00001',
          requestBody: { title: 'shared' },
          responseStatus: 200,
          responseBody: {
            id: '1hk153x00001',
            typeId: 'com.example/note@1',
            createdAt: '2024-01-01T00:00:00.000Z',
            updatedAt: '2024-01-02T00:00:00.000Z',
            content: { title: 'shared' },
            version: 2,
            entityId: FEED_OWNER,
            updatedBy: FEED_OWNER,
          },
        },
        frames: [
          {
            id: 'AA3f1X',
            event: 'record',
            data: {
              kind: 'changed',
              op: 'update',
              recordId: '1hk153x00001',
              typeId: 'com.example/note@1',
              version: 2,
              updatedAt: '2024-01-02T00:00:00.000Z',
              actor: { entityId: FEED_OWNER },
            },
          },
        ],
      },
    ],
  },
  {
    name: 'change-feed-typeid-filter-matches-by-baseid',
    description:
      'A ?typeId filter is matched by baseId, exactly as a grant is, so a type version bump ' +
      'never silently orphans a subscription: a connection filtered on note@1 receives note@2 ' +
      'changes, including the migration that produced them. A change to another type is not ' +
      'delivered at all — filtering here is exact rather than advisory, so a client that ' +
      'filters again is doing redundant work rather than defensive work.',
    path: '/changes?typeId=com.example/note@1',
    responseStatus: 200,
    openingFrames: [READY],
    activity: [
      {
        mutation: {
          name: 'change-feed-typeid-filter-other-type-mutation',
          description: 'A change to a record of an unrelated type.',
          method: 'PATCH',
          path: '/records/1hk153x03001',
          requestBody: { url: 'https://example.com' },
          responseStatus: 200,
          responseBody: {
            id: '1hk153x03001',
            typeId: 'com.example/bookmark@1',
            createdAt: '2024-01-01T00:00:00.000Z',
            updatedAt: '2024-01-02T00:00:00.000Z',
            content: { url: 'https://example.com' },
            version: 2,
            entityId: FEED_OWNER,
            updatedBy: FEED_OWNER,
          },
        },
        frames: [],
      },
      {
        mutation: {
          name: 'change-feed-typeid-filter-migrated-record-mutation',
          description: 'The note is migrated to note@2, which the filter still covers.',
          method: 'POST',
          path: '/records/1hk153x00001/migrate',
          requestBody: {
            toTypeId: 'com.example/note@2',
            content: { title: 'Hello', tags: [] },
          },
          responseStatus: 200,
          responseBody: {
            id: '1hk153x00001',
            typeId: 'com.example/note@2',
            createdAt: '2024-01-01T00:00:00.000Z',
            updatedAt: '2024-01-05T00:00:00.000Z',
            content: { title: 'Hello', tags: [] },
            version: 5,
            entityId: FEED_OWNER,
            updatedBy: FEED_OWNER,
          },
        },
        frames: [
          {
            id: 'AA3f1Y',
            event: 'record',
            data: {
              kind: 'changed',
              op: 'migrate',
              recordId: '1hk153x00001',
              typeId: 'com.example/note@2',
              version: 5,
              updatedAt: '2024-01-05T00:00:00.000Z',
              actor: { entityId: FEED_OWNER },
            },
          },
        ],
      },
    ],
  },
  {
    name: 'change-feed-reset-when-no-cursor-is-honored',
    description:
      'A server advertising resume:false answers every connection presenting a cursor with a ' +
      'reset, and is fully conformant in doing so. ready still leads — it carries the cursor ' +
      'the client resumes from *after* reconciling — and its seq is absent here, since a server ' +
      "that mints no cursors has none to name. A client's repair is the same for all three " +
      'reset reasons and is the same work as startup: reconcile by query.',
    path: '/changes',
    requestHeaders: { 'Last-Event-ID': 'AA3f1R' },
    responseStatus: 200,
    openingFrames: [
      { event: 'ready', data: {} },
      { event: 'reset', data: { reason: 'not_supported' } },
    ],
  },
  {
    name: 'change-feed-unknown-frame-names-are-ignored',
    description:
      'A client MUST ignore a frame whose event name it does not recognize, which is what makes ' +
      'a new frame an additive minor change rather than a break — type events and batch frames ' +
      'arrive that way. This fixture is a client obligation rather than a server one: a server ' +
      'implementing only this version emits no such frame, and a client that errors on one ' +
      'refuses a server that is conformant with a later minor. The record frame after it must ' +
      'still be delivered, since ignoring is not disconnecting.',
    path: '/changes',
    responseStatus: 200,
    openingFrames: [
      READY,
      { id: 'AA3f1Z', event: 'type', data: { typeId: 'com.example/note@2' } },
      {
        id: 'AA3f20',
        event: 'record',
        data: {
          kind: 'changed',
          op: 'update',
          recordId: '1hk153x00001',
          typeId: 'com.example/note@1',
          version: 2,
          updatedAt: '2024-01-02T00:00:00.000Z',
          actor: { entityId: FEED_OWNER },
        },
      },
    ],
  },
];

export const changeFeedSequenceFixtures: ChangeFeedSequenceFixture[] = [
  {
    name: 'change-feed-resume-delivers-what-was-missed',
    description:
      'The obligation a single connection cannot express: a client that comes back holding a ' +
      'cursor is owed what happened while it was gone. The first connection sees one change and ' +
      'closes; a second change lands with nobody listening; the reconnect presents the last id ' +
      'it saw and receives that second change, and only that one — the frame it already has is ' +
      'not replayed, since the cursor names what was delivered rather than where to rewind to. ' +
      'ready still leads on the reconnect. A server that answers this with a reset is ' +
      'conformant only if it advertises resume:false; one advertising resume:true and resuming ' +
      'from wherever it can is the failure this pins, because the gap it leaves is silent.',
    steps: [
      {
        name: 'change-feed-resume-first-connection',
        description: 'The client connects fresh and sees one change, whose id it retains.',
        path: '/changes',
        responseStatus: 200,
        openingFrames: [READY],
        activity: [
          {
            mutation: {
              name: 'change-feed-resume-first-change',
              description: 'The owner edits the note while the client is connected.',
              method: 'PATCH',
              path: '/records/1hk153x00001',
              requestBody: { title: 'first' },
              responseStatus: 200,
              responseBody: {
                id: '1hk153x00001',
                typeId: 'com.example/note@1',
                createdAt: '2024-01-01T00:00:00.000Z',
                updatedAt: '2024-01-02T00:00:00.000Z',
                content: { title: 'first' },
                version: 2,
                entityId: FEED_OWNER,
                updatedBy: FEED_OWNER,
              },
            },
            frames: [
              {
                id: 'AA3f1R',
                event: 'record',
                data: {
                  kind: 'changed',
                  op: 'update',
                  recordId: '1hk153x00001',
                  typeId: 'com.example/note@1',
                  version: 2,
                  updatedAt: '2024-01-02T00:00:00.000Z',
                  actor: { entityId: FEED_OWNER },
                },
              },
            ],
          },
        ],
      },
      {
        name: 'change-feed-resume-second-connection',
        description:
          'The client reconnects presenting the last id it saw, after a change it missed.',
        path: '/changes',
        requestHeaders: { 'Last-Event-ID': 'AA3f1R' },
        precedingMutations: [
          {
            name: 'change-feed-resume-missed-change',
            description: 'A second edit, made while no connection was open.',
            method: 'PATCH',
            path: '/records/1hk153x00001',
            requestBody: { title: 'second' },
            responseStatus: 200,
            responseBody: {
              id: '1hk153x00001',
              typeId: 'com.example/note@1',
              createdAt: '2024-01-01T00:00:00.000Z',
              updatedAt: '2024-01-03T00:00:00.000Z',
              content: { title: 'second' },
              version: 3,
              entityId: FEED_OWNER,
              updatedBy: FEED_OWNER,
            },
          },
        ],
        responseStatus: 200,
        openingFrames: [
          { event: 'ready', data: { seq: 'AA3f1S' } },
          {
            id: 'AA3f1S',
            event: 'record',
            data: {
              kind: 'changed',
              op: 'update',
              recordId: '1hk153x00001',
              typeId: 'com.example/note@1',
              version: 3,
              updatedAt: '2024-01-03T00:00:00.000Z',
              actor: { entityId: FEED_OWNER },
            },
          },
        ],
      },
    ],
  },
  {
    name: 'change-feed-reset-rather-than-resume-from-wherever-it-can',
    description:
      'The same reconnect against a server whose buffer no longer reaches the cursor. It says ' +
      'so with a reset instead of delivering what it still holds, because a partial resume is ' +
      'indistinguishable to the client from a complete one — it would apply the frames it got ' +
      'and never learn about the ones it did not. Nothing is silently skipped is the property ' +
      'that makes a feed worth trusting, and this is the one place a server is tempted to break ' +
      'it. The reason is informational; the repair is a reconcile by query either way.',
    steps: [
      {
        name: 'change-feed-reset-first-connection',
        description: 'The client connects fresh and retains the head cursor from ready.',
        path: '/changes',
        responseStatus: 200,
        openingFrames: [READY],
      },
      {
        name: 'change-feed-reset-expired-cursor',
        description:
          'The client reconnects long enough afterwards that its cursor has fallen out of the ' +
          "server's buffer.",
        path: '/changes',
        requestHeaders: { 'Last-Event-ID': FEED_HEAD_SEQ },
        responseStatus: 200,
        openingFrames: [
          { event: 'ready', data: { seq: 'AB90zT' } },
          { event: 'reset', data: { reason: 'cursor_expired' } },
        ],
      },
    ],
  },
];

// -------------------------------------------------------
// All fixtures
// -------------------------------------------------------

/**
 * Every fixture across every endpoint, for consumers that want to iterate
 * uniformly. Excludes attachmentDownloadFixtures, attachmentUploadFixtures,
 * authSequenceFixtures, changeFeedFixtures and changeFeedSequenceFixtures —
 * each a different shape (binary body, header-focused, or an ordered series
 * rather than a plain JSON request/response pair), imported separately.
 *
 * The auth fixtures are the one group here sent with no bearer token, since
 * they are how a token is earned.
 */
export const allConformanceFixtures: ConformanceFixture[] = [
  ...discoveryFixtures,
  ...authChallengeFixtures,
  ...authTokenFixtures,
  ...createRecordFixtures,
  ...queryRecordsFixtures,
  ...patchContentFixtures,
  ...deleteRecordFixtures,
  ...undeleteRecordFixtures,
  ...associateFixtures,
  ...dissociateFixtures,
  ...setPermissionsFixtures,
  ...setUnlistedFixtures,
  ...getVersionsFixtures,
  ...getVersionFixtures,
  ...getVersionsAfterMutateFixtures,
  ...restoreVersionFixtures,
  ...commitMigrationFixtures,
  ...errorResponseFixtures,
];
