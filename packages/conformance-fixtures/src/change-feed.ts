import type { WireRecordChange, WireReadyFrame, WireResetFrame } from '@haverstack/wire-types';
import type { ConformanceFixture } from './types.js';

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
const FEED_HEAD_CURSOR = 'AA3f1Q';

const READY: ChangeFeedFrame = { event: 'ready', data: { cursor: FEED_HEAD_CURSOR } };

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
            createdBy: { subjectId: FEED_OWNER },
          },
        },
        frames: [
          {
            id: 'AA3f1R',
            event: 'record',
            data: {
              kind: 'created',
              ops: ['create'],
              recordId: '1hk153x00001',
              typeId: 'com.example/note@1',
              version: 1,
              updatedAt: '2024-01-01T00:00:00.000Z',
              actor: { subjectId: FEED_OWNER },
            },
          },
        ],
      },
    ],
  },
  {
    name: 'change-feed-changed-frame-names-the-verb',
    description:
      'Nine mutation verbs arrive as kind "changed" — patch, associate, dissociate, ' +
      'reshare, migrate, restore, undelete, list and reparent — and `ops` is what ' +
      'separates them. A client branching on kind alone is correct and complete; one that ' +
      'needs to tell a reshare from an edit reads ops. Both fields are carried because the ' +
      'safe default has to be the easy one: a client wired to three named events would ' +
      'silently miss every other verb. The actor is the contributor who made this write, ' +
      'while the record keeps its own author.',
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
          requestBody: { contentPatch: { title: 'edited by a contributor' } },
          responseStatus: 200,
          responseBody: {
            id: '1hk153x00001',
            typeId: 'com.example/note@1',
            createdAt: '2024-01-01T00:00:00.000Z',
            updatedAt: '2024-01-02T00:00:00.000Z',
            content: { title: 'edited by a contributor' },
            version: 2,
            createdBy: { subjectId: FEED_OWNER },
            updatedBy: { subjectId: FEED_CONTRIBUTOR },
          },
        },
        frames: [
          {
            id: 'AA3f1S',
            event: 'record',
            data: {
              kind: 'changed',
              ops: ['patch'],
              recordId: '1hk153x00001',
              typeId: 'com.example/note@1',
              version: 2,
              updatedAt: '2024-01-02T00:00:00.000Z',
              actor: { subjectId: FEED_CONTRIBUTOR },
            },
          },
        ],
      },
    ],
  },
  {
    name: 'change-feed-associate-frame-carries-associationsAdded',
    description:
      'An associate() call reports op "associate" on the change feed, but never bumps version ' +
      "or touches updatedAt — the frame's version/updatedAt are exactly what the record already " +
      'held. `associationsAdded` is the only record of what the call moved: the association ' +
      'itself is never snapshotted, so a subscriber not listening for this exact frame has no ' +
      'other way to learn it. See docs/spec/events.md § The event shape.',
    path: '/changes',
    responseStatus: 200,
    openingFrames: [READY],
    activity: [
      {
        mutation: {
          name: 'change-feed-associate-frame-mutation',
          description: 'A contributor tags the note.',
          method: 'POST',
          path: '/records/1hk153x00001/associations',
          requestBody: { changes: [{ op: 'add', association: { kind: 'tag', label: 'starred' } }] },
          responseStatus: 200,
          responseBody: {
            id: '1hk153x00001',
            typeId: 'com.example/note@1',
            createdAt: '2024-01-01T00:00:00.000Z',
            updatedAt: '2024-01-01T00:00:00.000Z',
            content: { title: 'Hello', body: 'World' },
            version: 1,
            createdBy: { subjectId: FEED_OWNER },
            associations: [{ kind: 'tag', label: 'starred' }],
          },
        },
        frames: [
          {
            id: 'AA3f1S',
            event: 'record',
            data: {
              kind: 'changed',
              ops: ['associate'],
              recordId: '1hk153x00001',
              typeId: 'com.example/note@1',
              version: 1,
              updatedAt: '2024-01-01T00:00:00.000Z',
              actor: { subjectId: FEED_CONTRIBUTOR },
              associationsAdded: [{ kind: 'tag', label: 'starred' }],
            },
          },
        ],
      },
    ],
  },
  {
    name: 'change-feed-dissociate-frame-carries-associationsRemoved',
    description:
      'A dissociate() call reports op "dissociate" on the change feed, with the same non-bumping ' +
      'version/updatedAt an associate() frame carries. `associationsRemoved` names the removed ' +
      'association by identity only — never the annotation it carried — since it is no longer ' +
      'current. Assumes the note already carries the "starred" tag from a prior associate(). ' +
      'See docs/spec/events.md § The event shape.',
    path: '/changes',
    responseStatus: 200,
    openingFrames: [READY],
    activity: [
      {
        mutation: {
          name: 'change-feed-dissociate-frame-mutation',
          description: 'A contributor untags the note.',
          method: 'POST',
          path: '/records/1hk153x00001/associations',
          requestBody: {
            changes: [{ op: 'remove', association: { kind: 'tag', label: 'starred' } }],
          },
          responseStatus: 200,
          responseBody: {
            id: '1hk153x00001',
            typeId: 'com.example/note@1',
            createdAt: '2024-01-01T00:00:00.000Z',
            updatedAt: '2024-01-01T00:00:00.000Z',
            content: { title: 'Hello', body: 'World' },
            version: 1,
            createdBy: { subjectId: FEED_OWNER },
          },
        },
        frames: [
          {
            id: 'AA3f1S',
            event: 'record',
            data: {
              kind: 'changed',
              ops: ['dissociate'],
              recordId: '1hk153x00001',
              typeId: 'com.example/note@1',
              version: 1,
              updatedAt: '2024-01-01T00:00:00.000Z',
              actor: { subjectId: FEED_CONTRIBUTOR },
              associationsRemoved: [{ kind: 'tag', label: 'starred' }],
            },
          },
        ],
      },
    ],
  },
  {
    name: 'change-feed-deleted-frame-is-not-terminal',
    description:
      'A soft delete is kind "removed" and bumps a version like any other mutation, so the ' +
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
            createdBy: { subjectId: FEED_OWNER },
            deletedAt: '2024-01-03T00:00:00.000Z',
          },
        },
        frames: [
          {
            id: 'AA3f1T',
            event: 'record',
            data: {
              kind: 'removed',
              ops: ['delete'],
              recordId: '1hk153x00001',
              typeId: 'com.example/note@1',
              version: 3,
              updatedAt: '2024-01-03T00:00:00.000Z',
              actor: { subjectId: FEED_OWNER },
            },
          },
        ],
      },
    ],
  },
  {
    name: 'change-feed-unlist-frame-is-a-removed-kind',
    description:
      'Marking a record unlisted arrives as kind "removed" / op "unlist" — not "changed" — even ' +
      'though the record still exists and get() still resolves it. A subscriber without ' +
      'includeUnlisted already knows this record from before, and the record’s new state ' +
      '(unlistedAt now set) would otherwise be excluded by the very filter this event announces, ' +
      'so the transition is delivered on the same terms as an ordinary soft delete: the point is ' +
      'telling a subscriber to drop its copy, not that the record is gone. Unlike a soft ' +
      'delete it bumps no version, so the frame carries the version and updatedAt the record ' +
      'already had. See docs/spec/events.md § The unlisted transition and ' +
      'docs/spec/versioning.md § Version history.',
    path: '/changes',
    responseStatus: 200,
    openingFrames: [READY],
    activity: [
      {
        mutation: {
          name: 'change-feed-unlist-frame-mutation',
          description: 'The owner marks the note unlisted.',
          method: 'PATCH',
          path: '/records/1hk153x00001',
          requestBody: { unlisted: true },
          responseStatus: 200,
          responseBody: {
            id: '1hk153x00001',
            typeId: 'com.example/note@1',
            createdAt: '2024-01-01T00:00:00.000Z',
            updatedAt: '2024-01-02T00:00:00.000Z',
            content: { title: 'Hello' },
            version: 2,
            createdBy: { subjectId: FEED_OWNER },
            unlistedAt: '2024-01-03T00:00:00.000Z',
          },
        },
        frames: [
          {
            id: 'AA3f1U',
            event: 'record',
            data: {
              kind: 'removed',
              ops: ['unlist'],
              recordId: '1hk153x00001',
              typeId: 'com.example/note@1',
              version: 2,
              updatedAt: '2024-01-02T00:00:00.000Z',
              actor: { subjectId: FEED_OWNER },
            },
          },
        ],
      },
    ],
  },
  {
    name: 'change-feed-reparent-reaches-the-container-a-record-left',
    description:
      'A subscription filtered on parentId is told when a record leaves that container, not ' +
      'only when one arrives. The frame carries the destination in parentId, as every frame ' +
      'carries the record’s state at the moment of the change, so a subscriber compares it to ' +
      'its own filter to tell a departure from an arrival. The record’s post-change state ' +
      'alone would answer only for the destination, which is why this transition is matched ' +
      'against both containers. Kind is "changed", not "removed": the record is still there ' +
      'and still readable — only its container moved. A move bumps no version, so the frame ' +
      'carries the version and updatedAt the record already had. See ' +
      'docs/spec/events.md § The reparent transition.',
    path: '/changes?parentId=1hk153x0000f',
    responseStatus: 200,
    openingFrames: [READY],
    activity: [
      {
        mutation: {
          name: 'change-feed-reparent-frame-mutation',
          description: 'The owner moves the note out of the container the subscriber watches.',
          method: 'PATCH',
          path: '/records/1hk153x00001',
          requestBody: { parentId: '1hk153x0000g' },
          responseStatus: 200,
          responseBody: {
            id: '1hk153x00001',
            typeId: 'com.example/note@1',
            createdAt: '2024-01-01T00:00:00.000Z',
            updatedAt: '2024-01-02T00:00:00.000Z',
            content: { title: 'Hello' },
            version: 2,
            createdBy: { subjectId: FEED_OWNER },
            parentId: '1hk153x0000g',
          },
        },
        frames: [
          {
            id: 'AA3f1U',
            event: 'record',
            data: {
              kind: 'changed',
              ops: ['reparent'],
              recordId: '1hk153x00001',
              typeId: 'com.example/note@1',
              version: 2,
              updatedAt: '2024-01-02T00:00:00.000Z',
              parentId: '1hk153x0000g',
              actor: { subjectId: FEED_OWNER },
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
      'names it. Assumes prior state from change-feed-unlist-frame-is-a-removed-kind. See ' +
      'docs/spec/events.md § The unlisted transition.',
    path: '/changes',
    responseStatus: 200,
    openingFrames: [READY],
    activity: [
      {
        mutation: {
          name: 'change-feed-list-frame-mutation',
          description: 'The owner relists the note.',
          method: 'PATCH',
          path: '/records/1hk153x00001',
          requestBody: { unlisted: false },
          responseStatus: 200,
          responseBody: {
            id: '1hk153x00001',
            typeId: 'com.example/note@1',
            createdAt: '2024-01-01T00:00:00.000Z',
            updatedAt: '2024-01-02T00:00:00.000Z',
            content: { title: 'Hello' },
            version: 2,
            createdBy: { subjectId: FEED_OWNER },
          },
        },
        frames: [
          {
            id: 'AA3f1V',
            event: 'record',
            data: {
              kind: 'changed',
              ops: ['list'],
              recordId: '1hk153x00001',
              typeId: 'com.example/note@1',
              version: 2,
              updatedAt: '2024-01-02T00:00:00.000Z',
              actor: { subjectId: FEED_OWNER },
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
      'change-feed-unlist-frame-is-a-removed-kind). Assumes the note was already made unlisted. ' +
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
          requestBody: { contentPatch: { title: 'Edited while unlisted' } },
          responseStatus: 200,
          responseBody: {
            id: '1hk153x00001',
            typeId: 'com.example/note@1',
            createdAt: '2024-01-01T00:00:00.000Z',
            updatedAt: '2024-01-04T00:00:00.000Z',
            content: { title: 'Edited while unlisted' },
            version: 4,
            createdBy: { subjectId: FEED_OWNER },
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
      'no parentId, and no author. Purge is the erasure primitive, and a frame naming ' +
      'what was erased writes a permanent note of it into every subscriber log at the moment ' +
      'the stack finished destroying its own copy. What survives is the useful property: a ' +
      'purge tells a consumer holding the record to forget it, and tells one that never held it ' +
      'nothing. The actor comes from the request, since a purge stamps nothing on a ' +
      'record that no longer exists; the verb is owner-only and refuses delegation, so there is ' +
      'never a principal beside it. See docs/spec/events.md § Purged records carry nothing.',
    path: '/changes?include=record',
    responseStatus: 200,
    openingFrames: [READY],
    activity: [
      {
        mutation: {
          name: 'change-feed-purged-frame-mutation',
          description: 'The owner purges a note that had a parent and an author.',
          method: 'DELETE',
          path: '/records/1hk153x00002?purge=true',
          responseStatus: 200,
          responseBody: {
            id: '1hk153x00002',
            typeId: 'com.example/note@1',
            createdAt: '2024-01-01T00:00:00.000Z',
            updatedAt: '2024-01-02T00:00:00.000Z',
            content: { title: 'Gone', body: 'Destroyed' },
            version: 1,
            parentId: '1hk153x0000f',
            createdBy: { subjectId: 'entity-owner-123' },
          },
        },
        frames: [
          {
            id: 'AA3f1U',
            event: 'record',
            data: {
              kind: 'purged',
              ops: ['purge'],
              recordId: '1hk153x00002',
              typeId: 'com.example/note@1',
              version: 4,
              updatedAt: '2024-01-04T00:00:00.000Z',
              actor: { subjectId: FEED_OWNER },
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
          requestBody: { contentPatch: { title: 'Updated title' } },
          responseStatus: 200,
          responseBody: {
            id: '1hk153x00001',
            typeId: 'com.example/note@1',
            createdAt: '2024-01-01T00:00:00.000Z',
            updatedAt: '2024-01-02T00:00:00.000Z',
            content: { title: 'Updated title' },
            version: 2,
            createdBy: { subjectId: FEED_OWNER },
            updatedBy: { subjectId: FEED_OWNER },
          },
        },
        frames: [
          {
            id: 'AA3f1V',
            event: 'record',
            data: {
              kind: 'changed',
              ops: ['patch'],
              recordId: '1hk153x00001',
              typeId: 'com.example/note@1',
              version: 2,
              updatedAt: '2024-01-02T00:00:00.000Z',
              actor: { subjectId: FEED_OWNER },
              record: {
                id: '1hk153x00001',
                typeId: 'com.example/note@1',
                createdAt: '2024-01-01T00:00:00.000Z',
                updatedAt: '2024-01-02T00:00:00.000Z',
                content: { title: 'Updated title' },
                version: 2,
                createdBy: { subjectId: FEED_OWNER },
                updatedBy: { subjectId: FEED_OWNER },
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
      'on it, which is the same reasoning that keeps a count of the whole match off the query ' +
      'envelope. The predicate ' +
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
          requestBody: { contentPatch: { title: 'private' } },
          responseStatus: 200,
          responseBody: {
            id: '1hk153x09001',
            typeId: 'com.example/note@1',
            createdAt: '2024-01-01T00:00:00.000Z',
            updatedAt: '2024-01-02T00:00:00.000Z',
            content: { title: 'private' },
            version: 2,
            createdBy: { subjectId: FEED_OWNER },
            updatedBy: { subjectId: FEED_OWNER },
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
          requestBody: { contentPatch: { title: 'shared' } },
          responseStatus: 200,
          responseBody: {
            id: '1hk153x00001',
            typeId: 'com.example/note@1',
            createdAt: '2024-01-01T00:00:00.000Z',
            updatedAt: '2024-01-02T00:00:00.000Z',
            content: { title: 'shared' },
            version: 2,
            createdBy: { subjectId: FEED_OWNER },
            updatedBy: { subjectId: FEED_OWNER },
          },
        },
        frames: [
          {
            id: 'AA3f1X',
            event: 'record',
            data: {
              kind: 'changed',
              ops: ['patch'],
              recordId: '1hk153x00001',
              typeId: 'com.example/note@1',
              version: 2,
              updatedAt: '2024-01-02T00:00:00.000Z',
              actor: { subjectId: FEED_OWNER },
            },
          },
        ],
      },
    ],
  },
  {
    name: 'change-feed-typeid-filter-matches-exactly',
    description:
      'A ?typeId filter is an exact match, as it is on GET /records, so one filter selects the ' +
      'same records from both: a connection filtered on note@1 receives nothing for a record ' +
      'already at note@2. A migration out of note@1 is still delivered, because a type change ' +
      'is matched against the type it left as well as the one it entered — the frame carries ' +
      'the new typeId, and a subscriber reads the mismatch as a departure. A change to another ' +
      'type is not delivered at all: filtering here is exact rather than advisory.',
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
          requestBody: { contentPatch: { url: 'https://example.com' } },
          responseStatus: 200,
          responseBody: {
            id: '1hk153x03001',
            typeId: 'com.example/bookmark@1',
            createdAt: '2024-01-01T00:00:00.000Z',
            updatedAt: '2024-01-02T00:00:00.000Z',
            content: { url: 'https://example.com' },
            version: 2,
            createdBy: { subjectId: FEED_OWNER },
            updatedBy: { subjectId: FEED_OWNER },
          },
        },
        frames: [],
      },
      {
        mutation: {
          name: 'change-feed-typeid-filter-later-version-mutation',
          description: 'A change to a record already at note@2.',
          method: 'PATCH',
          path: '/records/1hk153x03002',
          requestBody: { contentPatch: { title: 'Later' } },
          responseStatus: 200,
          responseBody: {
            id: '1hk153x03002',
            typeId: 'com.example/note@2',
            createdAt: '2024-01-01T00:00:00.000Z',
            updatedAt: '2024-01-03T00:00:00.000Z',
            content: { title: 'Later', tags: [] },
            version: 2,
            createdBy: { subjectId: FEED_OWNER },
            updatedBy: { subjectId: FEED_OWNER },
          },
        },
        frames: [],
      },
      {
        mutation: {
          name: 'change-feed-typeid-filter-migration-mutation',
          description:
            'The note is migrated to note@2. The filter names the type it left, so the ' +
            'subscriber learns it is gone.',
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
            createdBy: { subjectId: FEED_OWNER },
            updatedBy: { subjectId: FEED_OWNER },
          },
        },
        frames: [
          {
            id: 'AA3f1Y',
            event: 'record',
            data: {
              kind: 'changed',
              ops: ['migrate'],
              recordId: '1hk153x00001',
              typeId: 'com.example/note@2',
              version: 5,
              updatedAt: '2024-01-05T00:00:00.000Z',
              actor: { subjectId: FEED_OWNER },
            },
          },
        ],
      },
    ],
  },
  {
    name: 'change-feed-baseid-filter-matches-every-version',
    description:
      'A ?baseId filter matches every version of a type family, so a type version bump never ' +
      'silently orphans a subscription: a connection filtered on com.example/note receives ' +
      'note@2 changes as well as note@1 ones. Unlike GET /records, where baseId is resolved ' +
      'client-side and refused on the wire, the feed carries it, because the versions it must ' +
      'cover include ones not yet registered when the connection opened.',
    path: '/changes?baseId=com.example/note',
    responseStatus: 200,
    openingFrames: [READY],
    activity: [
      {
        mutation: {
          name: 'change-feed-baseid-filter-other-type-mutation',
          description: 'A change to a record of an unrelated type.',
          method: 'PATCH',
          path: '/records/1hk153x03001',
          requestBody: { contentPatch: { url: 'https://example.com' } },
          responseStatus: 200,
          responseBody: {
            id: '1hk153x03001',
            typeId: 'com.example/bookmark@1',
            createdAt: '2024-01-01T00:00:00.000Z',
            updatedAt: '2024-01-02T00:00:00.000Z',
            content: { url: 'https://example.com' },
            version: 2,
            createdBy: { subjectId: FEED_OWNER },
            updatedBy: { subjectId: FEED_OWNER },
          },
        },
        frames: [],
      },
      {
        mutation: {
          name: 'change-feed-baseid-filter-later-version-mutation',
          description: 'A change to a record already at note@2.',
          method: 'PATCH',
          path: '/records/1hk153x03002',
          requestBody: { contentPatch: { title: 'Later' } },
          responseStatus: 200,
          responseBody: {
            id: '1hk153x03002',
            typeId: 'com.example/note@2',
            createdAt: '2024-01-01T00:00:00.000Z',
            updatedAt: '2024-01-03T00:00:00.000Z',
            content: { title: 'Later', tags: [] },
            version: 2,
            createdBy: { subjectId: FEED_OWNER },
            updatedBy: { subjectId: FEED_OWNER },
          },
        },
        frames: [
          {
            id: 'AA3f1Y',
            event: 'record',
            data: {
              kind: 'changed',
              ops: ['patch'],
              recordId: '1hk153x03002',
              typeId: 'com.example/note@2',
              version: 2,
              updatedAt: '2024-01-03T00:00:00.000Z',
              actor: { subjectId: FEED_OWNER },
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
      'the client resumes from *after* reconciling — and its cursor is absent here, since a server ' +
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
          ops: ['patch'],
          recordId: '1hk153x00001',
          typeId: 'com.example/note@1',
          version: 2,
          updatedAt: '2024-01-02T00:00:00.000Z',
          actor: { subjectId: FEED_OWNER },
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
              requestBody: { contentPatch: { title: 'first' } },
              responseStatus: 200,
              responseBody: {
                id: '1hk153x00001',
                typeId: 'com.example/note@1',
                createdAt: '2024-01-01T00:00:00.000Z',
                updatedAt: '2024-01-02T00:00:00.000Z',
                content: { title: 'first' },
                version: 2,
                createdBy: { subjectId: FEED_OWNER },
                updatedBy: { subjectId: FEED_OWNER },
              },
            },
            frames: [
              {
                id: 'AA3f1R',
                event: 'record',
                data: {
                  kind: 'changed',
                  ops: ['patch'],
                  recordId: '1hk153x00001',
                  typeId: 'com.example/note@1',
                  version: 2,
                  updatedAt: '2024-01-02T00:00:00.000Z',
                  actor: { subjectId: FEED_OWNER },
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
            requestBody: { contentPatch: { title: 'second' } },
            responseStatus: 200,
            responseBody: {
              id: '1hk153x00001',
              typeId: 'com.example/note@1',
              createdAt: '2024-01-01T00:00:00.000Z',
              updatedAt: '2024-01-03T00:00:00.000Z',
              content: { title: 'second' },
              version: 3,
              createdBy: { subjectId: FEED_OWNER },
              updatedBy: { subjectId: FEED_OWNER },
            },
          },
        ],
        responseStatus: 200,
        openingFrames: [
          { event: 'ready', data: { cursor: 'AA3f1S' } },
          {
            id: 'AA3f1S',
            event: 'record',
            data: {
              kind: 'changed',
              ops: ['patch'],
              recordId: '1hk153x00001',
              typeId: 'com.example/note@1',
              version: 3,
              updatedAt: '2024-01-03T00:00:00.000Z',
              actor: { subjectId: FEED_OWNER },
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
        requestHeaders: { 'Last-Event-ID': FEED_HEAD_CURSOR },
        responseStatus: 200,
        openingFrames: [
          { event: 'ready', data: { cursor: 'AB90zT' } },
          { event: 'reset', data: { reason: 'cursor_expired' } },
        ],
      },
    ],
  },
];
