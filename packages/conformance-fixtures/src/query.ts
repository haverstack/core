import type { WireQueryResponse } from '@haverstack/wire-types';
import type { ConformanceFixture } from './types.js';

// What these pin is the *envelope*, not the filtering: `cursor` — not
// `records.length` — is what says whether the result set is exhausted.
// That is a rule a server can satisfy by accident on a small test Stack
// and violate the moment a requester with partial visibility pages
// through a large one.

export const queryRecordsFixtures: ConformanceFixture<
  Record<string, unknown>,
  WireQueryResponse
>[] = [
  {
    name: 'query-envelope-is-records-and-cursor',
    description:
      'The query envelope carries records and cursor, and no count of the whole match. Every ' +
      'request a server serves is authenticated as some requester, so a count that ignores ' +
      'pagination would report how many Records exist beyond what that requester may read — ' +
      'the cardinality the permission check just hid. See docs/spec/wire-format.md ' +
      '§ Response envelope.',
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
    },
  },
  {
    name: 'query-get-records-uses-the-same-envelope',
    description:
      'GET /records — the native-field query endpoint a server reaching no content ' +
      'exposes — returns the identical envelope, under the same cursor rule. ' +
      'The two endpoints differ in what they can filter by, not in what they return.',
    method: 'GET',
    path: '/records?typeId=com.example%2Fnote%401&limit=2',
    responseStatus: 200,
    responseBody: {
      records: [],
      cursor: 'eyJjcmVhdGVkQXQiOjE3MDQwNjcyMDAwMDAsImlkIjoiMWhrMTUzeDAwMDIwIn0',
    },
  },
  {
    name: 'query-filters-by-content-presence',
    description:
      'filter.contentPresent names paths that must hold a value — the question an exact-match ' +
      'filter value cannot ask, since a value matches what is there rather than whether ' +
      'anything is. Its counterpart is a null content filter, which matches "no value at the ' +
      'path, or a value that is null". Both are element-wise through arrays, so a path holding ' +
      'both a null and a value satisfies each. A server declaring a content reach does NOT ' +
      'thereby promise presence: it needs filter.contentPresent, or it MUST refuse the filter ' +
      'rather than return the superset that ignoring it produces. ' +
      'See docs/spec/data-model.md § Filter.',
    method: 'POST',
    path: '/records/query',
    requestBody: { filter: { contentPresent: ['publishedAt'] }, limit: 2 },
    responseStatus: 200,
    responseBody: {
      records: [
        {
          id: '1hk153x00051',
          typeId: 'com.example/article@1',
          createdAt: '2024-01-01T00:00:00.000Z',
          updatedAt: '2024-01-01T00:00:00.000Z',
          content: { title: 'Published', publishedAt: '2024-03-01T00:00:00.000Z' },
          version: 1,
        },
      ],
      cursor: null,
    },
  },
  {
    name: 'query-sorts-by-a-content-field',
    description:
      'sort.contentField orders by a top-level content field, and is a separate member from ' +
      'sort.field rather than a widening of it: a content field may be named after a native ' +
      'column, so a single field would leave `version` ambiguous. A Record holding no value at ' +
      'the field sorts after every Record that has one, whichever direction the sort runs — an ' +
      'undated post belongs at the end of a date-ordered listing either way. ' +
      'See docs/spec/data-model.md § Sorting by a content field.',
    method: 'POST',
    path: '/records/query',
    requestBody: { sort: { contentField: 'publishedAt', direction: 'desc' }, limit: 3 },
    responseStatus: 200,
    responseBody: {
      records: [
        {
          id: '1hk153x00031',
          typeId: 'com.example/article@1',
          createdAt: '2024-01-01T00:00:00.000Z',
          updatedAt: '2024-01-01T00:00:00.000Z',
          content: { title: 'Newest', publishedAt: '2024-03-01T00:00:00.000Z' },
          version: 1,
        },
        {
          id: '1hk153x00032',
          typeId: 'com.example/article@1',
          createdAt: '2024-01-01T00:00:00.000Z',
          updatedAt: '2024-01-01T00:00:00.000Z',
          content: { title: 'Older', publishedAt: '2024-01-15T00:00:00.000Z' },
          version: 1,
        },
        {
          id: '1hk153x00033',
          typeId: 'com.example/article@1',
          createdAt: '2024-01-01T00:00:00.000Z',
          updatedAt: '2024-01-01T00:00:00.000Z',
          content: { title: 'Never published' },
          version: 1,
        },
      ],
      cursor: null,
    },
  },
  {
    name: 'query-content-sort-defaults-to-ascending',
    description:
      'A sort that names a field with no direction runs ascending, as ORDER BY does — native ' +
      'column or content field alike. A content date reads newest first only when the caller ' +
      'asks for `desc`. A server built on Stack.query() inherits this. ' +
      'See docs/spec/data-model.md § Sorting and pagination.',
    method: 'POST',
    path: '/records/query',
    requestBody: { sort: { contentField: 'title' }, limit: 2 },
    responseStatus: 200,
    responseBody: {
      records: [
        {
          id: '1hk153x00061',
          typeId: 'com.example/article@1',
          createdAt: '2024-01-01T00:00:00.000Z',
          updatedAt: '2024-01-01T00:00:00.000Z',
          content: { title: 'apple' },
          version: 1,
        },
        {
          id: '1hk153x00062',
          typeId: 'com.example/article@1',
          createdAt: '2024-01-01T00:00:00.000Z',
          updatedAt: '2024-01-01T00:00:00.000Z',
          content: { title: 'Zebra' },
          version: 1,
        },
      ],
      cursor: null,
    },
  },
  {
    name: 'query-without-sort-returns-newest-first',
    description:
      'A query naming no sort answers by createdAt, newest first — the order a feed-style ' +
      "listing reads in. That is the opposite of `sort: { field: 'createdAt' }`, which names a " +
      'sort and so runs ascending. See docs/spec/data-model.md § Sorting and pagination.',
    method: 'POST',
    path: '/records/query',
    requestBody: { limit: 2 },
    responseStatus: 200,
    responseBody: {
      records: [
        {
          id: '1hk153x00071',
          typeId: 'com.example/article@1',
          createdAt: '2024-02-01T00:00:00.000Z',
          updatedAt: '2024-02-01T00:00:00.000Z',
          content: { title: 'Second' },
          version: 1,
        },
        {
          id: '1hk153x00072',
          typeId: 'com.example/article@1',
          createdAt: '2024-01-01T00:00:00.000Z',
          updatedAt: '2024-01-01T00:00:00.000Z',
          content: { title: 'First' },
          version: 1,
        },
      ],
      cursor: null,
    },
  },
  {
    name: 'query-content-sort-folds-case-and-accents',
    description:
      'Text orders by a folded key rather than by code point: compatibility-decompose, drop ' +
      'combining marks, lowercase (locale-independently). So `apple` precedes `Émile` precedes ' +
      '`Zebra`, where raw code-point order would file every capital ahead of every lowercase ' +
      'letter and every accented word after both. A server implementing this wire protocol ' +
      'MUST reproduce that fold, or two implementations answer one query in two orders. What ' +
      'the fold does not promise — locale tailoring, and the orderings that depend on it — is ' +
      'in docs/spec/data-model.md § Text ordering.',
    method: 'POST',
    path: '/records/query',
    requestBody: { sort: { contentField: 'title', direction: 'asc' }, limit: 3 },
    responseStatus: 200,
    responseBody: {
      records: [
        {
          id: '1hk153x00041',
          typeId: 'com.example/article@1',
          createdAt: '2024-01-01T00:00:00.000Z',
          updatedAt: '2024-01-01T00:00:00.000Z',
          content: { title: 'apple' },
          version: 1,
        },
        {
          id: '1hk153x00042',
          typeId: 'com.example/article@1',
          createdAt: '2024-01-01T00:00:00.000Z',
          updatedAt: '2024-01-01T00:00:00.000Z',
          content: { title: 'Émile' },
          version: 1,
        },
        {
          id: '1hk153x00043',
          typeId: 'com.example/article@1',
          createdAt: '2024-01-01T00:00:00.000Z',
          updatedAt: '2024-01-01T00:00:00.000Z',
          content: { title: 'Zebra' },
          version: 1,
        },
      ],
      cursor: null,
    },
  },
  {
    name: 'query-get-sorts-by-a-content-field',
    description:
      'On GET /records the content sort travels as ?sortContent=, a parameter of its own rather ' +
      'than a value of ?sort= — the same "which parameter appears says which was meant" shape ' +
      'the relationship filter uses, and the only way to keep a content field named `version` ' +
      'distinct from the native column on a raw query string. A server MUST reject a request ' +
      'carrying both with 400. See docs/spec/wire-format.md § Records.',
    method: 'GET',
    path: '/records?sortContent=publishedAt&direction=asc',
    responseStatus: 200,
    responseBody: { records: [], cursor: null },
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
    responseBody: { records: [], cursor: null },
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
    responseBody: { records: [], cursor: null },
  },
  {
    name: 'query-related-to-external-namespace',
    description:
      'A relationship filter naming something outside the Stack travels as relatedToNs plus an ' +
      'optional relatedToId. Omitting relatedToId matches every target in the namespace, which ' +
      'is how a bridge asks what it has already syndicated. A server MUST reject a request ' +
      'mixing parameters from two target kinds with 400, and can rely on at least one relatedTo ' +
      'parameter being present whenever the filter is used — the filter never encodes to ' +
      'nothing. See docs/spec/wire-format.md § Records.',
    method: 'GET',
    path: '/records?relatedToNs=atproto',
    responseStatus: 200,
    responseBody: { records: [], cursor: null },
  },
  {
    name: 'query-attachment-label-and-file',
    description:
      'An attachment filter travels as attachmentLabel and attachmentFileId, either alone or ' +
      'both. Together they match a single attachment association — a Record whose cover is ' +
      'one file and whose thumbnail is another does not match cover plus the thumbnail file. ' +
      'attachmentFileId matches associations only; a server MUST NOT also count a file-ref ' +
      'content field, which is what referencesFileId asks. ' +
      'See docs/spec/wire-format.md § Records.',
    method: 'GET',
    path: '/records?attachmentLabel=cover&attachmentFileId=933f0f80dc48c9e7d885c2f665caca88a709dbbba35e93a17c2cc30ebb963f0d',
    responseStatus: 200,
    responseBody: { records: [], cursor: null },
  },
  {
    name: 'query-references-file',
    description:
      'referencesFileId matches every Record that references the file: through an attachment ' +
      'association under any label, or through a top-level file-ref content field. It is the ' +
      "question deleteAttachment()'s reference check and garbage collection ask. " +
      'See docs/spec/wire-format.md § Records.',
    method: 'GET',
    path: '/records?referencesFileId=933f0f80dc48c9e7d885c2f665caca88a709dbbba35e93a17c2cc30ebb963f0d',
    responseStatus: 200,
    responseBody: { records: [], cursor: null },
  },
];
