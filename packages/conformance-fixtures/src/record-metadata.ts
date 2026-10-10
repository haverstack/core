import type { WireRecord } from '@haverstack/wire-types';
import type { ConformanceFixture } from './types.js';

// -------------------------------------------------------
// Associations
// -------------------------------------------------------

export const amendAssociationsFixtures: ConformanceFixture<Record<string, unknown>, WireRecord>[] =
  [
    {
      name: 'amend-associations-add-tag',
      description:
        'POST /records/:id/associations takes a list of changes and applies it as one write, ' +
        'here a single add, without bumping version or touching ' +
        'updatedAt, answering with the record it produced — carrying whatever version/updatedAt ' +
        'it already had. The endpoint never reads If-Match: there is nothing for a precondition ' +
        'on version to guard, so a header sent here is ignored rather than refused, whatever ' +
        'its value. See docs/spec/wire-format.md § Associations.',
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
        associations: [{ kind: 'tag', label: 'starred' }],
      },
    },
    {
      name: 'amend-associations-add-attachment-record-id',
      description:
        'An attachment association may name the `_attachment` record whose upload established it, ' +
        'so a reference to shared bytes can resolve its own filename. The field travels verbatim ' +
        'in both directions and is outside association identity. See docs/spec/attachments.md ' +
        '§ Naming the upload a reference came from.',
      method: 'POST',
      path: '/records/1hk153x00001/associations',
      requestBody: {
        changes: [
          {
            op: 'add',
            association: {
              kind: 'attachment',
              label: 'embed',
              fileId: '933f0f80dc48c9e7d885c2f665caca88a709dbbba35e93a17c2cc30ebb963f0d',
              attachmentRecordId: '1hk153x00009',
            },
          },
        ],
      },
      responseStatus: 200,
      responseBody: {
        id: '1hk153x00001',
        typeId: 'com.example/note@1',
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
        content: { title: 'Hello', body: 'World' },
        version: 1,
        associations: [
          {
            kind: 'attachment',
            label: 'embed',
            fileId: '933f0f80dc48c9e7d885c2f665caca88a709dbbba35e93a17c2cc30ebb963f0d',
            attachmentRecordId: '1hk153x00009',
          },
        ],
      },
    },
    {
      name: 'amend-associations-add-relationship-external-target',
      description:
        'A relationship association carries its target as a discriminated union — the kind names ' +
        'which identifier space the value belongs to, so a server stores and returns it verbatim ' +
        'rather than flattening the arms into one id column. See docs/spec/data-model.md ' +
        '§ Associations.',
      method: 'POST',
      path: '/records/1hk153x00001/associations',
      requestBody: {
        changes: [
          {
            op: 'add',
            association: {
              kind: 'relationship',
              label: 'syndicated-to',
              target: {
                kind: 'external',
                ns: 'atproto',
                id: 'at://did:plc:abc/app.bsky.feed.post/3k4',
              },
            },
          },
        ],
      },
      responseStatus: 200,
      responseBody: {
        id: '1hk153x00001',
        typeId: 'com.example/note@1',
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
        content: { title: 'Hello', body: 'World' },
        version: 1,
        associations: [
          {
            kind: 'relationship',
            label: 'syndicated-to',
            target: {
              kind: 'external',
              ns: 'atproto',
              id: 'at://did:plc:abc/app.bsky.feed.post/3k4',
            },
          },
        ],
      },
    },
    {
      name: 'amend-associations-swap-in-one-request',
      description:
        'One list mixes a remove and an add, so replacing an association lands as a single ' +
        'write with no intermediate state and a single journal entry. Removes apply before ' +
        'adds. See docs/spec/adapters.md § Amending associations.',
      method: 'POST',
      path: '/records/1hk153x00001/associations',
      requestBody: {
        changes: [
          { op: 'remove', association: { kind: 'tag', label: 'draft' } },
          { op: 'add', association: { kind: 'tag', label: 'published' } },
        ],
      },
      responseStatus: 200,
      responseBody: {
        id: '1hk153x00001',
        typeId: 'com.example/note@1',
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
        content: { title: 'Hello', body: 'World' },
        version: 1,
        associations: [{ kind: 'tag', label: 'published' }],
      },
    },
    {
      name: 'amend-associations-remove-attachment-by-identity',
      description:
        'A remove names (kind, label, fileId) — the association it takes away may ' +
        'carry an `attachmentRecordId`, which annotates the reference rather than identifying it. ' +
        'Like an add, this never bumps version or touches updatedAt, and never reads ' +
        'If-Match — a header sent here is ignored rather than refused. See ' +
        'docs/spec/data-model.md § Associations.',
      method: 'POST',
      path: '/records/1hk153x00001/associations',
      requestBody: {
        changes: [
          {
            op: 'remove',
            association: {
              kind: 'attachment',
              label: 'embed',
              fileId: '933f0f80dc48c9e7d885c2f665caca88a709dbbba35e93a17c2cc30ebb963f0d',
            },
          },
        ],
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
      name: 'amend-associations-remove-tag',
      description:
        'A remove in the same list body takes an association away without bumping version or ' +
        'touching updatedAt, answering with the record it produced — here with associations ' +
        'gone entirely and version/updatedAt exactly as they already stood. There is no ' +
        'separate delete path: a DELETE request body has no defined semantics (RFC 9110 ' +
        '§9.3.5), and one POST carries adds and removes alike.',
      method: 'POST',
      path: '/records/1hk153x00001/associations',
      requestBody: { changes: [{ op: 'remove', association: { kind: 'tag', label: 'starred' } }] },
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
  ];

// -------------------------------------------------------
// Permissions
// -------------------------------------------------------

export const amendPermissionsFixtures: ConformanceFixture<Record<string, unknown>, WireRecord>[] = [
  {
    name: 'amend-permissions-add-entity',
    description:
      'POST /records/:id/permissions takes a list of changes, here adding one element and amending the set rather than ' +
      'replacing it, and answering with the record it produced. Permission elements are ' +
      'associations, so this bumps no version and does not touch updatedAt, and the endpoint ' +
      'never reads If-Match. It carries the reshare gate, not the write bit: a write-holder who ' +
      'is neither owner nor creator gets 403. See docs/spec/wire-format.md § Permissions.',
    method: 'POST',
    path: '/records/1hk153x00001/permissions',
    requestBody: {
      changes: [
        {
          op: 'add',
          association: {
            kind: 'permission',
            label: 'read',
            grantee: { kind: 'entity', entityId: 'did:key:z6MkMember' },
          },
        },
      ],
    },
    responseStatus: 200,
    responseBody: {
      id: '1hk153x00001',
      typeId: 'com.example/note@1',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
      content: { title: 'Hello', body: 'World' },
      version: 1,
      permissions: [
        {
          kind: 'permission',
          label: 'read',
          grantee: { kind: 'entity', entityId: 'did:key:z6MkMember' },
        },
      ],
    },
  },
  {
    name: 'amend-permissions-add-group-role',
    description:
      'A group grantee always names a role: `member` is the wider set and `admin` the narrower, ' +
      'matching the roster labels where admin implies member. There is no absent-role spelling ' +
      'to fall back on. See docs/spec/access-control.md § Record-level permissions.',
    method: 'POST',
    path: '/records/1hk153x00001/permissions',
    requestBody: {
      changes: [
        {
          op: 'add',
          association: {
            kind: 'permission',
            label: 'read',
            grantee: { kind: 'group', groupId: '1hk153x0000g', role: 'admin' },
          },
        },
      ],
    },
    responseStatus: 200,
    responseBody: {
      id: '1hk153x00001',
      typeId: 'com.example/note@1',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
      content: { title: 'Hello', body: 'World' },
      version: 1,
      permissions: [
        {
          kind: 'permission',
          label: 'read',
          grantee: { kind: 'group', groupId: '1hk153x0000g', role: 'admin' },
        },
      ],
    },
  },
  {
    name: 'amend-permissions-grant-read-and-write-together',
    description:
      'Granting edit access takes a `read` and a `write` for one grantee, and a `write` is ' +
      'refused without the `read` beside it. One list carries both, so the set is judged as it ' +
      'will stand and no write lands holding the invalid intermediate. ' +
      'See docs/spec/access-control.md § Write implies read.',
    method: 'POST',
    path: '/records/1hk153x00001/permissions',
    requestBody: {
      changes: [
        {
          op: 'add',
          association: {
            kind: 'permission',
            label: 'read',
            grantee: { kind: 'entity', entityId: 'did:key:z6MkMember' },
          },
        },
        {
          op: 'add',
          association: {
            kind: 'permission',
            label: 'write',
            grantee: { kind: 'entity', entityId: 'did:key:z6MkMember' },
          },
        },
      ],
    },
    responseStatus: 200,
    responseBody: {
      id: '1hk153x00001',
      typeId: 'com.example/note@1',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
      content: { title: 'Hello', body: 'World' },
      version: 1,
      permissions: [
        {
          kind: 'permission',
          label: 'read',
          grantee: { kind: 'entity', entityId: 'did:key:z6MkMember' },
        },
        {
          kind: 'permission',
          label: 'write',
          grantee: { kind: 'entity', entityId: 'did:key:z6MkMember' },
        },
      ],
    },
  },
  {
    name: 'amend-permissions-remove-anyone',
    description:
      'A remove on POST /records/:id/permissions takes one permission element away, answering ' +
      'with the record it produced — here with permissions gone entirely and version/updatedAt ' +
      'exactly as they already stood. One POST carries adds and removes, as on the association ' +
      'endpoint. ' +
      'Reach to the world is its own kind, so withdrawing it names that kind rather than ' +
      'clearing a field. See docs/spec/wire-format.md § Permissions.',
    method: 'POST',
    path: '/records/1hk153x00001/permissions',
    requestBody: { changes: [{ op: 'remove', association: { kind: 'anyone', label: 'read' } }] },
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
];

export const permissionsChangeFixtures: ConformanceFixture<
  { permissions: unknown[] },
  WireRecord
>[] = [
  {
    name: 'set-permissions-anyone',
    description:
      "A change set's `permissions` key replaces the whole permission set, and nothing else: " +
      'the `associations` key is a separate domain, so a Record keeps its tags across this ' +
      'write. Permission entries are associations, so this bumps no version and does not ' +
      'move updatedAt — the journal carries the delta in full. See ' +
      'docs/spec/wire-format.md § Records and docs/spec/access-control.md ' +
      '§ Record-level permissions.',
    method: 'PATCH',
    path: '/records/1hk153x00001',
    requestBody: { permissions: [{ kind: 'anyone', label: 'read' }] },
    responseStatus: 200,
    responseBody: {
      id: '1hk153x00001',
      typeId: 'com.example/note@1',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
      content: { title: 'Hello', body: 'World' },
      version: 1,
      permissions: [{ kind: 'anyone', label: 'read' }],
      associations: [{ kind: 'tag', label: 'draft' }],
    },
  },
  {
    name: 'set-permissions-empty-is-private',
    description:
      'An empty permissions array makes the record private (owner-only), and the record comes ' +
      'back with no permissions field at all rather than an empty one. Its associations are ' +
      'untouched: the two keys replace within their own domains.',
    method: 'PATCH',
    path: '/records/1hk153x00001',
    requestBody: { permissions: [] },
    responseStatus: 200,
    responseBody: {
      id: '1hk153x00001',
      typeId: 'com.example/note@1',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
      content: { title: 'Hello', body: 'World' },
      version: 1,
      associations: [{ kind: 'tag', label: 'draft' }],
    },
  },
];

// -------------------------------------------------------
// Unlisted
// -------------------------------------------------------

export const unlistedChangeFixtures: ConformanceFixture<{ unlisted: boolean }, WireRecord>[] = [
  {
    name: 'set-unlisted-true',
    description:
      "A change set's `unlisted` key withholds a record from enumeration without changing who may " +
      'read it: the response carries unlistedAt, and permissions (if any) are untouched. ' +
      'It bumps no version and does not move updatedAt — the journal carries the transition ' +
      'in full, so no snapshot is owed. unlistedAt is the write moment all the same, which is ' +
      "why it runs ahead of updatedAt here. Orthogonal to the change set's `permissions` key — " +
      'see docs/spec/unlisted.md and docs/spec/versioning.md § Version history.',
    method: 'PATCH',
    path: '/records/1hk153x00001',
    requestBody: { unlisted: true },
    responseStatus: 200,
    responseBody: {
      id: '1hk153x00001',
      typeId: 'com.example/note@1',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
      content: { title: 'Hello', body: 'World' },
      version: 1,
      unlistedAt: '2024-01-02T00:00:00.000Z',
    },
  },
  {
    name: 'set-unlisted-false-relists',
    description:
      'A change set carrying `"unlisted": false` reverses it — the record comes back ' +
      'with unlistedAt absent, and is enumerable again by an unfiltered query() and the change ' +
      'feed. Idempotent, like undelete, and no-bump in the same direction it was set: assumes ' +
      'prior state from set-unlisted-true.',
    method: 'PATCH',
    path: '/records/1hk153x00001',
    requestBody: { unlisted: false },
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
];

// -------------------------------------------------------
// Parent
// -------------------------------------------------------

export const parentChangeFixtures: ConformanceFixture<{ parentId: string | null }, WireRecord>[] = [
  {
    name: 'set-parent-moves-a-record-into-a-container',
    description:
      "A change set's `parentId` key moves a record between containers, and touches nothing " +
      'else — content, permissions and associations come back as they were. It bumps no ' +
      'version and does not move updatedAt: the journal entry carries previousParentId, so a ' +
      'move is already reversible without a snapshot. Containment decides which listings ' +
      'enumerate the record, never who may read it, so the response is not a permission ' +
      'change. See docs/spec/data-model.md § Reparenting and docs/spec/versioning.md ' +
      '§ Version history.',
    method: 'PATCH',
    path: '/records/1hk153x00001',
    requestBody: { parentId: '1hk153x0000f' },
    responseStatus: 200,
    responseBody: {
      id: '1hk153x00001',
      typeId: 'com.example/note@1',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
      content: { title: 'Hello', body: 'World' },
      version: 1,
      parentId: '1hk153x0000f',
    },
  },
  {
    name: 'set-parent-null-moves-a-record-to-the-root',
    description:
      'A null parentId is the root sentinel, matching the "null" spelling GET /records accepts ' +
      'for the same field: the record comes back with parentId absent. Assumes prior state from ' +
      'set-parent-moves-a-record-into-a-container.',
    method: 'PATCH',
    path: '/records/1hk153x00001',
    requestBody: { parentId: null },
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
];
