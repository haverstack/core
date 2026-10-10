import type { WireJournalResponse } from '@haverstack/wire-types';
import type { ConformanceFixture } from './types.js';

// The second durable tier beside version history, and the only place an
// association's prior state survives (docs/spec/wire-format.md § Journal).
// A server answers these for a requester holding the mutate surface; the
// 403 case is error-permission-denied-journal-read-only.

export const getJournalFixtures: ConformanceFixture<undefined, WireJournalResponse>[] = [
  {
    name: 'get-journal-reads-the-whole-log-oldest-first',
    description:
      'GET /records/:id/journal with no params reads the whole log, oldest first, and answers ' +
      'cursor null because nothing follows. `version` stands still across the associate() at ' +
      'seq 2, which is why `seq` is the only ordering the log carries. ' +
      'See docs/spec/wire-format.md § Journal and docs/spec/journal.md § Ordering.',
    method: 'GET',
    path: '/records/1hk153x00001/journal',
    responseStatus: 200,
    responseBody: {
      entries: [
        {
          seq: 1,
          at: '2024-01-01T00:00:00.000Z',
          kind: 'created',
          ops: ['create'],
          version: 1,
          typeId: 'com.example/note@1',
          actor: { subjectId: 'entity-owner-123' },
        },
        {
          seq: 2,
          at: '2024-01-02T00:00:00.000Z',
          kind: 'changed',
          ops: ['associate'],
          version: 1,
          typeId: 'com.example/note@1',
          actor: { subjectId: 'entity-contributor-789' },
          associations: [{ op: 'add', association: { kind: 'tag', label: 'starred' } }],
        },
      ],
      cursor: null,
    },
  },
  {
    name: 'get-journal-page-reports-a-cursor-to-resume-from',
    description:
      'A server may answer a page shorter than the limit asked for — this endpoint is the one ' +
      'read with no ceiling when limit is omitted, so it needs that freedom. cursor is ' +
      'therefore the only end-of-log signal: a short page does not mean an exhausted log. Its ' +
      'value is the seq to send back as afterSeq. A client reconstructing a full history ' +
      'follows it rather than taking the first page for the answer.',
    method: 'GET',
    path: '/records/1hk153x00001/journal?afterSeq=0&limit=2',
    responseStatus: 200,
    responseBody: {
      entries: [
        {
          seq: 1,
          at: '2024-01-01T00:00:00.000Z',
          kind: 'created',
          ops: ['create'],
          version: 1,
          typeId: 'com.example/note@1',
        },
      ],
      cursor: 1,
    },
  },
  {
    name: 'get-journal-entry-keeps-what-an-associate-overwrote',
    description:
      '`associations` is the field with no counterpart on the change feed, and the whole ' +
      "reason this tier exists. Re-pointing an attachment association's attachmentRecordId " +
      'overwrites the old value in place; the feed reports only what is true now, so the entry ' +
      'is the only record of what it replaced. A repoint carries both halves on one element — ' +
      'the association as it now stands and the `previous` it displaced — so no consumer has ' +
      'to join one list against another to find the pair. ' +
      'See docs/spec/attachments.md § Naming the upload a reference came from.',
    method: 'GET',
    path: '/records/1hk153x00001/journal?afterSeq=2',
    responseStatus: 200,
    responseBody: {
      entries: [
        {
          seq: 3,
          at: '2024-01-03T00:00:00.000Z',
          kind: 'changed',
          ops: ['associate'],
          version: 1,
          typeId: 'com.example/note@1',
          actor: { subjectId: 'entity-owner-123' },
          associations: [
            {
              op: 'repoint',
              association: {
                kind: 'attachment',
                label: 'embed',
                fileId: '933f0f80dc48c9e7d885c2f665caca88a709dbbba35e93a17c2cc30ebb963f0d',
                attachmentRecordId: '1hk153x0000b',
              },
              previous: {
                kind: 'attachment',
                label: 'embed',
                fileId: '933f0f80dc48c9e7d885c2f665caca88a709dbbba35e93a17c2cc30ebb963f0d',
                attachmentRecordId: '1hk153x00009',
              },
            },
          ],
        },
      ],
      cursor: null,
    },
  },
  {
    name: 'get-journal-entry-keeps-what-a-dissociate-removed',
    description:
      'A removal is as undoable from the log as a re-point: `association` is the element in ' +
      'full, attachmentRecordId included. The change frame for the same write names identity ' +
      'only — kind, label and fileId — because a notification reports what is true now, and ' +
      'the annotation no longer describes anything current. That asymmetry is the tier: the ' +
      'feed says what happened, the journal says what it happened to. ' +
      'See docs/spec/journal.md § The entry.',
    method: 'GET',
    path: '/records/1hk153x00001/journal?afterSeq=3',
    responseStatus: 200,
    responseBody: {
      entries: [
        {
          seq: 4,
          at: '2024-01-04T00:00:00.000Z',
          kind: 'changed',
          ops: ['dissociate'],
          version: 1,
          typeId: 'com.example/note@1',
          actor: { subjectId: 'entity-owner-123' },
          associations: [
            {
              op: 'remove',
              association: {
                kind: 'attachment',
                label: 'embed',
                fileId: '933f0f80dc48c9e7d885c2f665caca88a709dbbba35e93a17c2cc30ebb963f0d',
                attachmentRecordId: '1hk153x0000b',
              },
            },
          ],
        },
      ],
      cursor: null,
    },
  },
  {
    name: 'get-journal-reparent-entry-spells-the-root-as-null',
    description:
      'previousParentId is the one field on any response where null is a value rather than an ' +
      'input spelling. Absent means the entry is not a reparent; present and null means the ' +
      'record moved out of the root. Collapsing the two — as a record body does, where ' +
      'absent is the root — would lose which one happened, and this entry is the only place ' +
      "a move's origin survives at all. parentId, which says where the record landed, " +
      'follows the ordinary rule and is absent for the root. `version` stands still across a ' +
      'move, as it does across an association change. ' +
      'See docs/spec/wire-format.md § Journal.',
    method: 'GET',
    path: '/records/1hk153x00001/journal?afterSeq=3',
    responseStatus: 200,
    responseBody: {
      entries: [
        {
          seq: 4,
          at: '2024-01-04T00:00:00.000Z',
          kind: 'changed',
          ops: ['reparent'],
          version: 1,
          typeId: 'com.example/note@1',
          parentId: '1hk153x0000f',
          previousParentId: null,
          actor: { subjectId: 'entity-owner-123' },
        },
      ],
      cursor: null,
    },
  },
];
