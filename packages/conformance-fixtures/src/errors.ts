import type { WireError } from '@haverstack/wire-types';
import type { ConformanceFixture } from './types.js';

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
    requestBody: { contentPatch: { title: 'New title' } },
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
    name: 'error-permission-denied-journal-read-only',
    description:
      'GET /records/:id/journal from a requester who can read the record but cannot write it ' +
      'returns 403 / code "permission" — the same mutate-surface gate the version endpoints ' +
      'apply, for the same reason. A log of who changed what, gated on current read access, ' +
      "would make a record's past as reachable as its present: gaining read access today is " +
      'not an entitlement to the trail of every tag it has ever carried. ' +
      'See docs/spec/journal.md § Reading it.',
    method: 'GET',
    path: '/records/1hk153x00001/journal',
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
    requestBody: { contentPatch: { title: 'New title' } },
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
      'access to it. See docs/spec/disclosure.md § Which refusal a Record answers with.',
    method: 'PATCH',
    path: '/records/1hk153x00001',
    requestBody: { contentPatch: { title: 'New title' } },
    responseStatus: 404,
    responseBody: {
      error: { code: 'not_found', message: 'Record "1hk153x00001" not found.' },
    },
  },
  {
    name: 'error-not-found-journal-of-a-record-that-is-gone',
    description:
      'GET /records/:id/journal for a record the server does not have — never created, or ' +
      'purged — returns 404 / code "not_found", never an empty log. An empty log means ' +
      '"nothing changed" unconditionally, which is the reading a client reconstructing an ' +
      "association's history depends on; answering it here would make that reading " +
      'ambiguous exactly where it matters. This is the one 404 the journal endpoint gives: ' +
      'the endpoint itself is mandatory, so a server with no journal to offer may not answer ' +
      '404 for a record it holds. See docs/spec/journal.md § Reading it.',
    method: 'GET',
    path: '/records/1hk153x0a00b/journal',
    responseStatus: 404,
    responseBody: {
      error: { code: 'not_found', message: 'Record "1hk153x0a00b" not found.' },
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
    name: 'error-conflict-parent-does-not-exist',
    description:
      'A change set naming a `parentId` that does not exist returns 409 with code ' +
      '"conflict". A parentId a caller names has to resolve; POST /records with a parentId is ' +
      'refused the same way. Restore is the exception — see ' +
      'restore-version-puts-the-record-back-in-its-old-container.',
    method: 'PATCH',
    path: '/records/1hk153x00001',
    requestBody: { parentId: '1hk153xffffz' },
    responseStatus: 409,
    responseBody: {
      error: {
        code: 'conflict',
        message:
          'Cannot parent record "1hk153x00001" to "1hk153xffffz": no such record. A container ' +
          'has to exist when it is named.',
      },
    },
  },
  {
    name: 'error-bad-request-malformed-parent-id',
    description:
      'A parentId that is not a well-formed record id returns 400 with code "bad_request", ' +
      'checked before existence so the answer names what is wrong rather than reporting a ' +
      'lookup that could never match. The empty string is one of these, not a spelling of the ' +
      'root — the root is `null` on this endpoint.',
    method: 'PATCH',
    path: '/records/1hk153x00001',
    requestBody: { parentId: '' },
    responseStatus: 400,
    responseBody: {
      error: {
        code: 'bad_request',
        message: 'Invalid parentId "": expected 12 lowercase Crockford base-32 characters.',
      },
    },
  },
  {
    name: 'error-bad-request-unknown-query-param',
    description:
      'A query param the endpoint does not define returns 400 with code "bad_request" rather ' +
      'than being ignored: an ignored filter param answers a wider query than the one sent, ' +
      'with a 200 that never says so. The same holds on every endpoint. See ' +
      'docs/spec/wire-format.md § Unrecognized input.',
    method: 'GET',
    path: '/records?authorId=did%3Akey%3Az6MkMember',
    responseStatus: 400,
    responseBody: {
      error: { code: 'bad_request', message: 'Unknown query param: authorId' },
    },
  },
  {
    name: 'error-bad-request-non-boolean-param',
    description:
      'A boolean query param takes only "true" or "false"; any other value returns 400 with ' +
      'code "bad_request" rather than reading as false. See docs/spec/wire-format.md ' +
      '§ Unrecognized input.',
    method: 'GET',
    path: '/records?includeDeleted=1',
    responseStatus: 400,
    responseBody: {
      error: {
        code: 'bad_request',
        message: 'Invalid includeDeleted: expected true or false, got "1"',
      },
    },
  },
  {
    name: 'error-bad-request-unknown-query-body-key',
    description:
      'POST /records/query refuses a key it does not define at any depth of the body — here ' +
      'inside filter.createdBy — with 400 / code "bad_request". See docs/spec/wire-format.md ' +
      '§ Unrecognized input.',
    method: 'POST',
    path: '/records/query',
    requestBody: { filter: { createdBy: { authorId: 'did:key:z6MkMember' } } },
    responseStatus: 400,
    responseBody: {
      error: { code: 'bad_request', message: 'Unknown key in filter.createdBy: authorId' },
    },
  },
  {
    name: 'error-bad-request-unknown-record-key',
    description:
      'POST /records accepts every key a wire record carries — dropping the server-assigned ' +
      'ones — and refuses any other with 400 / code "bad_request". See ' +
      'docs/spec/wire-format.md § Unrecognized input.',
    method: 'POST',
    path: '/records',
    requestBody: {
      typeId: 'com.example/note@1',
      content: { title: 'Hello' },
      title: 'Hello',
    },
    responseStatus: 400,
    responseBody: { error: { code: 'bad_request', message: 'Unknown record key: title' } },
  },
  {
    name: 'error-bad-request-unknown-grantee-key',
    description:
      'A permission element carries only the keys its grantee kind defines; any other — here a ' +
      'scope on an entity grantee — returns 400 with code "bad_request" and grants nothing. ' +
      'Ignored, it would store a narrower-looking grant than the one that applies. See ' +
      'docs/spec/data-model.md § Associations.',
    method: 'POST',
    path: '/records/1hk153x00001/permissions',
    requestBody: {
      changes: [
        {
          op: 'add',
          association: {
            kind: 'permission',
            label: 'read',
            grantee: { kind: 'entity', entityId: 'did:key:z6MkMember', scope: 'comments' },
          },
        },
      ],
    },
    responseStatus: 400,
    responseBody: {
      error: {
        code: 'bad_request',
        message: 'Unknown key in changes[0].association.grantee: scope',
      },
    },
  },
  {
    name: 'error-bad-request-non-boolean-purge',
    description:
      'DELETE /records/:id takes purge only as "true" or "false"; any other value returns 400 ' +
      'with code "bad_request" and deletes nothing. Read as false, a purge the caller meant ' +
      'becomes a soft delete that answers 200. See docs/spec/wire-format.md § Unrecognized input.',
    method: 'DELETE',
    path: '/records/1hk153x00001?purge=1',
    responseStatus: 400,
    responseBody: {
      error: { code: 'bad_request', message: 'Invalid purge: expected true or false, got "1"' },
    },
  },
  {
    name: 'error-bad-request-unknown-auth-token-key',
    description:
      'POST /auth/token takes did, nonce and signature and nothing else; any other key — here ' +
      'a subjectId naming whom the token should act for — returns 400 with code "bad_request" ' +
      'and issues no token. Ignoring it would answer with a token the client did not ask for. ' +
      'See docs/spec/wire-format.md § Unrecognized input.',
    method: 'POST',
    path: '/auth/token',
    requestBody: {
      did: 'did:key:z6Mkfsz9oK6i2355mvEwtDYdAmqCN6kmQETThJtARfj9iGum',
      nonce: 'k7Qm2ZxRt9vLbNc4Hy8Wf3',
      signature:
        'CIvHvqS75hEpPDZi7hwLFOMM44-UCMuF5HzZ9_OIAMQvsGAYGsvXXpXQTP3KaPH2qKnQxl2j3xcB_v-axIx8Bg',
      subjectId: 'did:key:z6Mktp5FtRqj2M7JxnPz9JWGMCUTE5o3XGt1br11TczKGp7B',
    },
    responseStatus: 400,
    responseBody: {
      error: { code: 'bad_request', message: 'Unknown key in auth token body: subjectId' },
    },
  },
  {
    name: 'error-validation-failed',
    description:
      'PATCH content that fails the target type schema returns 422 with code "validation" and ' +
      'field-level details — reconstructed as StackValidationError, with `details` populating ' +
      '`.errors`.',
    method: 'PATCH',
    path: '/records/1hk153x00001',
    requestBody: { contentPatch: { title: 42 } },
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
    name: 'error-validation-enum-value-not-listed',
    description:
      'PATCH content setting an enum field to a value its `values` list does not name returns ' +
      '422 with code "validation", the detail naming the allowed values. An enum value is a ' +
      "string, so the type check passes and only the list refuses it. Assumes the record's " +
      'type declares { status: { kind: "enum", values: ["want", "reading", "finished"] } }.',
    method: 'PATCH',
    path: '/records/1hk153x00001',
    requestBody: { contentPatch: { status: 'abandoned' } },
    responseStatus: 422,
    responseBody: {
      error: {
        code: 'validation',
        message: 'Content validation failed',
        details: [
          {
            path: 'status',
            message: 'Expected one of "want", "reading", "finished", got "abandoned"',
          },
        ],
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
      "A change set's `permissions` key producing a set where some grantee holds `write` with " +
      'no `read` beside it returns 422 with code "validation". A write-holder reaches the ' +
      'record and its whole history through the mutate surface, so the combination withholds ' +
      'nothing while appearing to. A cross-element invariant, asked of the set the write would ' +
      'produce: the same 422 answers a `permissions` key that drops the `read` out from under ' +
      'a `write` already stored. The server refuses it wherever a request body carries ' +
      'permissions, POST /records included. See docs/spec/access-control.md ' +
      '§ Write implies read.',
    method: 'PATCH',
    path: '/records/1hk153x00001',
    requestBody: {
      permissions: [
        {
          kind: 'permission',
          label: 'write',
          grantee: { kind: 'entity', entityId: 'did:key:z6MkMember' },
        },
      ],
    },
    responseStatus: 422,
    responseBody: {
      error: {
        code: 'validation',
        message: 'Invalid arguments',
        details: [
          {
            path: 'permissions[0]',
            message:
              'write requires read: a write-holder reaches the record and its history through the mutate surface, so a `write` element with no `read` for the same grantee withholds nothing. Grant `read` and `write` together: grantAccess(id, [read, write])',
          },
        ],
      },
    },
  },
  {
    name: 'error-validation-amend-permissions-write-without-read',
    description:
      'POST /records/:id/permissions adding `write` alone for a grantee holding no `read` ' +
      'returns 422 with code "validation" and changes nothing: `write` never implies `read`, ' +
      'so the request names both. The set the whole list produces is what is checked. See ' +
      'docs/spec/access-control.md § Write implies read.',
    method: 'POST',
    path: '/records/1hk153x00001/permissions',
    requestBody: {
      changes: [
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
    responseStatus: 422,
    responseBody: {
      error: {
        code: 'validation',
        message: 'Invalid arguments',
        details: [
          {
            path: 'permissions[0]',
            message:
              'write requires read: a write-holder reaches the record and its history through the mutate surface, so a `write` element with no `read` for the same grantee withholds nothing. Grant `read` and `write` together: grantAccess(id, [read, write])',
          },
        ],
      },
    },
  },
  {
    name: 'error-bad-request-amend-associations-repoint',
    description:
      'A `repoint` is recorded by the journal, never requested: POST /records/:id/associations ' +
      'returns 400 with code "bad_request" for it, since it is not an op the endpoint defines. ' +
      'An `add` naming an attachment the record already holds re-points it in place. See ' +
      'docs/spec/wire-format.md § Associations.',
    method: 'POST',
    path: '/records/1hk153x00001/associations',
    requestBody: {
      changes: [
        {
          op: 'repoint',
          association: { kind: 'tag', label: 'starred' },
          previous: { kind: 'tag', label: 'starred' },
        },
      ],
    },
    responseStatus: 400,
    responseBody: {
      error: {
        code: 'bad_request',
        message:
          'Invalid association edits body: changes[0].op: "repoint" is recorded by the journal, not requested. Send { op: \'add\', association }: an add naming an attachment the record already holds re-points it in place.',
      },
    },
  },
  {
    name: 'error-validation-grant-without-grantee',
    description:
      'POST /records creating a _grant@1 record whose content carries no `grantee` returns 422 ' +
      "with code \"validation\". A Grant's reach is spelled by its grantee: `{ kind: 'entity' }`, " +
      "`{ kind: 'group' }` with a member/admin role, or `{ kind: 'authenticated' }` for any " +
      'authenticated entity. None of them is reachable by omission, so a body that lost the ' +
      'field — mapped from a request, imported, migrated — is refused rather than stored as a ' +
      'grant to every authenticated entity. A grantee naming an unknown `kind`, or carrying an ' +
      'empty entityId or groupId, is refused the same way and confers nothing wherever one is ' +
      'already stored. See docs/spec/access-control.md § Type-level grants.',
    method: 'POST',
    path: '/records',
    requestBody: {
      id: '1hk153x06008',
      typeId: '_grant@1',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
      content: { baseId: 'com.example/comment', actions: ['read-any'] },
      version: 1,
    },
    responseStatus: 422,
    responseBody: {
      error: {
        code: 'validation',
        message: 'Content validation failed',
        details: [{ path: 'grantee', message: 'Required field is missing' }],
      },
    },
  },
  {
    name: 'error-validation-grant-versioned-base-id',
    description:
      'POST /records creating a _grant@1 record whose `baseId` carries an `@version` suffix ' +
      'returns 422 with code "validation", the refusal naming the family to use. A grant ' +
      'reaches a whole type family, so a versioned target would read as pinned to one version ' +
      'while covering them all; wherever one is already stored it confers nothing. ' +
      'See docs/spec/access-control.md § Refused at the write, and again at evaluation.',
    method: 'POST',
    path: '/records',
    requestBody: {
      id: '1hk153x0601a',
      typeId: '_grant@1',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
      content: {
        baseId: 'com.example/comment@1',
        actions: ['read-any'],
        grantee: { kind: 'authenticated' },
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
            path: 'baseId',
            message:
              'baseId: "com.example/comment@1" names one version; pass the family "com.example/comment"',
          },
        ],
      },
    },
  },
  {
    name: 'error-validation-grant-protected-system-type',
    description:
      'POST /records creating a _grant@1 record whose `baseId` names `_grant`, `_config` or ' +
      '`_app` returns 422 with code "validation", however the record is written: the target ' +
      'rule holds on every `_grant` write, not only through grantType(). ' +
      'See docs/spec/access-control.md § Refused at the write, and again at evaluation.',
    method: 'POST',
    path: '/records',
    requestBody: {
      id: '1hk153x0601b',
      typeId: '_grant@1',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
      content: { baseId: '_app', actions: ['create'], grantee: { kind: 'authenticated' } },
      version: 1,
    },
    responseStatus: 422,
    responseBody: {
      error: {
        code: 'validation',
        message: 'Content validation failed',
        details: [
          {
            path: 'baseId',
            message:
              'Cannot grant on "_app": grants on _grant, _config, _app are refused to prevent privilege escalation',
          },
        ],
      },
    },
  },
  {
    name: 'error-validation-grant-group-grantee-without-role',
    description:
      'POST /records creating a _grant@1 record whose grantee names the `group` tier but ' +
      'carries no `role` returns 422 with code "validation". A closed `object` field holds one ' +
      "properties set, so the schema can only require `kind`; each arm's own fields are " +
      'required on the write instead. Without that a grant missing one stores, answers 200, ' +
      'and denies forever at evaluation — a share that reads as though it worked and never ' +
      'did. An `entity` grantee with no `entityId`, and a grantee naming an unknown `kind`, ' +
      'are refused the same way. See docs/spec/access-control.md § Type-level grants.',
    method: 'POST',
    path: '/records',
    requestBody: {
      id: '1hk153x06009',
      typeId: '_grant@1',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
      content: {
        baseId: 'com.example/comment',
        actions: ['read-any'],
        grantee: { kind: 'group', groupId: '1hk153x05001' },
      },
      version: 1,
    },
    responseStatus: 422,
    responseBody: {
      error: {
        code: 'validation',
        message: 'Content validation failed',
        details: [
          { path: 'grantee.role', message: "A group grantee requires role 'member' or 'admin'." },
        ],
      },
    },
  },
  {
    name: 'error-validation-grant-entity-grantee-without-entity-id',
    description:
      'POST /records creating a _grant@1 record whose grantee names the `entity` tier but ' +
      'carries no `entityId` returns 422 with code "validation" — the `entity` arm\'s half of ' +
      'the rule error-validation-grant-group-grantee-without-role pins for the `group` arm. The ' +
      'schema cannot ask it, so the write does: a closed `object` field holds one properties ' +
      'set, which can only require `kind`. Stored instead, the grant would name nobody and deny ' +
      'forever while reading as a share that worked. ' +
      'See docs/spec/access-control.md § Who a grant reaches.',
    method: 'POST',
    path: '/records',
    requestBody: {
      id: '1hk153x06010',
      typeId: '_grant@1',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
      content: {
        baseId: 'com.example/comment',
        actions: ['read-any'],
        grantee: { kind: 'entity' },
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
            path: 'grantee.entityId',
            message: 'An entity grantee requires a non-empty entityId.',
          },
        ],
      },
    },
  },
  {
    name: 'error-validation-grant-entity-grantee-with-empty-entity-id',
    description:
      'POST /records creating a _grant@1 record whose `entityId` is the empty string returns ' +
      '422 with code "validation", and the same detail an absent one earns. Empty is a ' +
      'separate input class from absent, and the distinction is where a presence check and a ' +
      'truthiness check stop agreeing: a grantee that is present but names nobody reaches no ' +
      'one, so it is refused on the same grounds rather than stored. An empty `groupId` is ' +
      'refused the same way. See docs/spec/access-control.md § Who a grant reaches.',
    method: 'POST',
    path: '/records',
    requestBody: {
      id: '1hk153x06011',
      typeId: '_grant@1',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
      content: {
        baseId: 'com.example/comment',
        actions: ['read-any'],
        grantee: { kind: 'entity', entityId: '' },
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
            path: 'grantee.entityId',
            message: 'An entity grantee requires a non-empty entityId.',
          },
        ],
      },
    },
  },
  {
    name: 'error-validation-grant-group-grantee-without-group-id',
    description:
      'POST /records creating a _grant@1 record whose grantee names the `group` tier and a ' +
      'role but no `groupId` returns 422 with code "validation". A role with no roster to read ' +
      'it from names nobody, so the arm is incomplete in the same way one carrying a groupId ' +
      'and no role is. See docs/spec/access-control.md § Who a grant reaches.',
    method: 'POST',
    path: '/records',
    requestBody: {
      id: '1hk153x06012',
      typeId: '_grant@1',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
      content: {
        baseId: 'com.example/comment',
        actions: ['read-any'],
        grantee: { kind: 'group', role: 'member' },
      },
      version: 1,
    },
    responseStatus: 422,
    responseBody: {
      error: {
        code: 'validation',
        message: 'Content validation failed',
        details: [
          { path: 'grantee.groupId', message: 'A group grantee requires a non-empty groupId.' },
        ],
      },
    },
  },
  {
    name: 'error-validation-grant-group-grantee-with-listing-only-role',
    description:
      "POST /records creating a _grant@1 record whose group grantee carries role 'any' returns " +
      '422 with code "validation". `any` is a widening a *query* can ask for — ' +
      "listTypeGrants({ kind: 'group', groupId, role: 'any' }) returns every grant naming that " +
      'group, whichever role — and it is not a role an entity can hold, so it can never reach ' +
      'storage. A stored grant carrying it would match a roster question nobody can answer. ' +
      'This is the one grantee value that is well-formed in one API and refused in the other, ' +
      'which is why it is pinned separately from an unrecognized role. ' +
      'See docs/spec/access-control.md § Listing and revoking.',
    method: 'POST',
    path: '/records',
    requestBody: {
      id: '1hk153x06013',
      typeId: '_grant@1',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
      content: {
        baseId: 'com.example/comment',
        actions: ['read-any'],
        grantee: { kind: 'group', groupId: '1hk153x05001', role: 'any' },
      },
      version: 1,
    },
    responseStatus: 422,
    responseBody: {
      error: {
        code: 'validation',
        message: 'Content validation failed',
        details: [
          { path: 'grantee.role', message: "A group grantee requires role 'member' or 'admin'." },
        ],
      },
    },
  },
  {
    name: 'error-validation-grant-grantee-with-unknown-kind',
    description:
      'POST /records creating a _grant@1 record whose grantee names a `kind` outside the three ' +
      'tiers returns 422 with code "validation". There is no wider tier to fall back to: the ' +
      'refusal is what keeps an unrecognized grantee from being read as the nearest thing that ' +
      'does resolve. Evaluation takes the same posture toward one already stored, reading it as ' +
      'conferring nothing. See docs/spec/access-control.md § Who a grant reaches.',
    method: 'POST',
    path: '/records',
    requestBody: {
      id: '1hk153x06014',
      typeId: '_grant@1',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
      content: {
        baseId: 'com.example/comment',
        actions: ['read-any'],
        grantee: { kind: 'everyone' },
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
            path: 'grantee.kind',
            message: "A grantee must name its tier: 'entity', 'group' or 'authenticated'.",
          },
        ],
      },
    },
  },
  {
    name: 'error-validation-grant-null-grantee',
    description:
      'POST /records creating a _grant@1 record whose `grantee` is JSON `null` returns 422 with ' +
      'code "validation", reported as the missing required field it is. `null` is not read as ' +
      'absent-then-defaulted, which is the reading that would turn a serializer emitting nulls ' +
      'for unset fields into a grant to every authenticated entity. ' +
      'See docs/spec/access-control.md § Type-level grants.',
    method: 'POST',
    path: '/records',
    requestBody: {
      id: '1hk153x06015',
      typeId: '_grant@1',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
      content: {
        baseId: 'com.example/comment',
        actions: ['read-any'],
        grantee: null,
      },
      version: 1,
    },
    responseStatus: 422,
    responseBody: {
      error: {
        code: 'validation',
        message: 'Content validation failed',
        details: [{ path: 'grantee', message: 'Required field is missing' }],
      },
    },
  },
  {
    name: 'error-validation-anyone-element-labelled-write',
    description:
      'POST /records/:id/permissions with an `anyone` element labelled anything but `read` ' +
      'returns 422 with code "validation". `read` is the whole of what the tier can say — ' +
      'world-writability is not in the model — so the label is not a bit to widen. Refusing it ' +
      'at the write matters beyond the element itself: a stored `anyone` element carrying ' +
      '`write` would otherwise be read as world read *and* satisfy the `read` a `write` element ' +
      'needs beside it, so one malformed element would silence the ' +
      'write-implies-read invariant for every grantee on the record. Evaluation reads it as ' +
      'naming no reach for the same reason. ' +
      'See docs/spec/access-control.md § Record-level permissions.',
    method: 'POST',
    path: '/records/1hk153x00001/permissions',
    requestBody: { changes: [{ op: 'add', association: { kind: 'anyone', label: 'write' } }] },
    responseStatus: 422,
    responseBody: {
      error: {
        code: 'validation',
        message: 'Invalid arguments',
        details: [
          {
            path: 'changes[0].association.label',
            message: 'An `anyone` association carries only `read`.',
          },
        ],
      },
    },
  },
  {
    name: 'error-permission-grant-on-an-ungrantable-family-confers-nothing',
    description:
      'A grant cannot be written for `_grant`, `_config` or `_app`, and one that reached ' +
      'storage some other way confers nothing at evaluation. Assumes a stored _grant@1 Record ' +
      "naming `_app@1` with actions ['create', 'read-any'] and this requester as its entity " +
      'grantee — reachable because a server mapping a request body, an import and a foreign ' +
      "server's response all produce grant Records that grantType() never vetted. The create below " +
      'MUST still return 403 with code "permission". Each of the three families hands the ' +
      'grantee the machinery the model rests on; `_app` is the sharpest, since an app card ' +
      'claiming a DID that is not its own is what verified attribution rests on. ' +
      'See docs/spec/access-control.md § Refused at the write, and again at evaluation.',
    method: 'POST',
    path: '/records',
    requestBody: {
      id: '1hk153x06016',
      typeId: '_app@1',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
      content: {
        name: 'Claimed app',
        did: 'did:key:z6MkfNotesAppKeyClaimedByTheClient00000000000000',
      },
      version: 1,
    },
    responseStatus: 403,
    responseBody: { error: { code: 'permission', message: 'Permission denied' } },
  },
  {
    name: 'error-not-found-mutate-grant-with-no-read-companion',
    description:
      'A mutate verb needs a read verb of matching scope in the same grant, or it conveys ' +
      'nothing. Assumes a stored _grant@1 Record naming com.example/note@1 with actions ' +
      "['create', 'update-any'] and this requester as its entity grantee, plus a record of " +
      'that type authored by someone else at "1hk153x00001". The PATCH MUST return 404 with ' +
      'code "not_found", not 403: the grant conveys neither the update nor a read, and a ' +
      'requester who cannot read the record is told nothing about its existence. The companion ' +
      'has to sit in the same Record because a grant is revoked whole — satisfying the rule ' +
      'across two would let revoking the read one leave a mutate-without-read grant standing. ' +
      '`create` is the exception and needs no companion: writing a record you cannot read is ' +
      'the drop-box, and it discloses nothing. ' +
      'See docs/spec/access-control.md § Write implies read.',
    method: 'PATCH',
    path: '/records/1hk153x00001',
    requestBody: { contentPatch: { title: 'Seized' } },
    responseStatus: 404,
    responseBody: { error: { code: 'not_found', message: 'Record not found' } },
  },
  {
    name: 'error-query-permission-kind-in-associations-key',
    description:
      'A `permission` named in the `associations` key returns 400 with code "query". ' +
      'Authority and data share storage and never share a call: the association verbs are ' +
      'gated on the write bit alone, so an authority element reaching them would let a ' +
      'write-holder grant themselves access. The refusal is the wrong-surface answer, not a ' +
      'malformed-value one. See docs/spec/access-control.md § Record-level permissions.',
    method: 'PATCH',
    path: '/records/1hk153x00001',
    requestBody: {
      associations: [
        {
          kind: 'permission',
          label: 'read',
          grantee: { kind: 'entity', entityId: 'did:key:z6MkMember' },
        },
      ],
    },
    responseStatus: 400,
    responseBody: {
      error: {
        code: 'bad_request',
        message:
          'associations does not carry authority: a "permission" association belongs to the ' +
          '`permissions` surface — use grantAccess()/revokeAccess(), or the `permissions` change-set key.',
      },
    },
  },
  {
    name: 'error-query-association-kind-in-permissions-key',
    description:
      'The mirror refusal: a `tag` named in the `permissions` key returns 400 with code ' +
      '"query", rather than quietly becoming an ACL entry the `associations` projection never ' +
      'shows. See docs/spec/access-control.md § Record-level permissions.',
    method: 'PATCH',
    path: '/records/1hk153x00001',
    requestBody: { permissions: [{ kind: 'tag', label: 'draft' }] },
    responseStatus: 400,
    responseBody: {
      error: {
        code: 'bad_request',
        message:
          'permissions carries authority alone: a "tag" association belongs to the ' +
          '`associations` surface — use associate()/dissociate(), or the `associations` change-set key.',
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
    requestBody: { contentPatch: { mimeType: 'image/jpeg' } },
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
      'Reconstructed as StackBadRequestError. "not-a-valid-cursor" is not valid base64 ' +
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
      "A cursor payload is a server's own to shape — this one carries the sort position this " +
      'implementation writes, and what the fixture pins is the branch, not the encoding.',
    method: 'POST',
    path: '/records/query',
    requestBody: {
      cursor: 'eyJrIjoibmF0aXZlIiwiZiI6ImJhZGZpZWxkIiwiaSI6IjFoazE1M3gwMDAwMSIsInYiOjEyM30=',
    },
    responseStatus: 400,
    responseBody: {
      error: {
        code: 'bad_request',
        message: 'Invalid cursor: unknown sort field "badfield"',
      },
    },
  },

  {
    name: 'error-bad-request-both-sort-parameters',
    description:
      'A request naming both ?sort= and ?sortContent= returns 400 with code "bad_request" ' +
      'rather than resolving one of them: a content field may be named after a native column, ' +
      'so there is no correct way to guess which was meant — the same posture as a request ' +
      'mixing two relationship target kinds. See docs/spec/wire-format.md § Records.',
    method: 'GET',
    path: '/records?sort=createdAt&sortContent=publishedAt',
    responseStatus: 400,
    responseBody: {
      error: {
        code: 'bad_request',
        message: 'A sort names either a native field or a content field, never both.',
      },
    },
  },

  {
    name: 'error-payload-too-large-record-body',
    description:
      "A record body exceeding the server's request-size limit returns 413 with code " +
      '"payload_too_large" — the same code and class as an oversized attachment upload, since a ' +
      'client acts on both identically. limits.attachmentBytes bounds attachment bytes only: a ' +
      "record body and a PATCH body have no ceiling in core, so this one is the server's to " +
      'set and to state (as limits.contentBytes in discovery, letting Stack.create()/Stack.mutate() ' +
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
      'and whether one survives a write depends on how an implementation sets keys: assigning ' +
      '__proto__ reaches the prototype setter and drops the write, while JSON.parse stores it as ' +
      'an ordinary property. ' +
      'A server built on core inherits the refusal through ordinary record validation; one ' +
      'mapping request bodies onto storage directly applies it itself. See ' +
      'docs/spec/data-model.md § Reserved content keys.',
    method: 'PATCH',
    path: '/records/1hk153x02011',
    requestBody: {
      contentPatch: JSON.parse('{"__proto__": {"polluted": true}}') as Record<string, unknown>,
    },
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
    requestBody: { contentPatch: { title: 'New title' } },
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
    name: 'error-schema-drift-enum-values-removed',
    description:
      'POST /types redefining an enum field with fewer values narrows what the field accepts, ' +
      'so it is not additive and returns 409 with code "schema_drift", naming the removed ' +
      'values. Adding values, or an enum becoming a plain string, accepts strictly more and is ' +
      'additive. Assumes "com.example/book@1" is already stored with { status: { kind: "enum", ' +
      'values: ["want", "reading", "finished"] } }.',
    method: 'POST',
    path: '/types',
    requestBody: {
      id: 'com.example/book@1',
      baseId: 'com.example/book',
      version: 1,
      name: 'Book',
      schema: { status: { kind: 'enum', values: ['want', 'reading'] } },
      schemaHash: '5d1e0c9b8a7f6e5d4c3b2a1908f7e6d5c4b3a291807f6e5d4c3b2a1908f7e6d5',
      createdAt: '2024-01-01T00:00:00.000Z',
    },
    responseStatus: 409,
    responseBody: {
      error: {
        code: 'schema_drift',
        message:
          'Schema drift detected for type "com.example/book@1": the stored schema and the new ' +
          'definition differ beyond additive evolution (new optional fields only). Bump the ' +
          'version instead of redefining "com.example/book@1" in place.',
        schemaDrift: {
          typeId: 'com.example/book@1',
          violations: [{ path: 'status', message: 'enum values removed: "finished"' }],
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
      'id never reaches type-schema validation). Reconstructed as StackBadRequestError.',
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
        message: 'Invalid ID "_hk153x00001": uses the reserved "_" prefix.',
      },
    },
  },
  {
    name: 'error-conflict-delete-config',
    description:
      'DELETE /records/_config — soft or purge — is always refused with 409 / ' +
      'code "conflict": _config holds the stack\'s identity (ownerEntityId, read at open and ' +
      'consulted by every permission check) and deleting it either bricks the stack (purge) or ' +
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
    requestBody: {
      contentPatch: { entityId: 'did:key:z6MkvVv7EXm3g3XZ8k4hqYqK5zqfSj6pS4KvL5s6cQzYzZq3' },
    },
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
    requestBody: { contentPatch: { title: 'New title' } },
    responseStatus: 401,
  },
];
