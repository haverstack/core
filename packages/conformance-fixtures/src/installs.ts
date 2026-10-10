import type { WireError, WireInstallRequest, WireInstallResponse } from '@haverstack/wire-types';
import type { ConformanceFixture } from './types.js';

// POST /installs is how an app presents its manifest to a stack it holds
// its own key for (docs/spec/wire-format.md § Installs). The owner
// approves out of band; these pin only what the app sees. The key being
// installed is always the session's — the body never names one.

const INSTALL_MANIFEST: WireInstallRequest['manifest'] = {
  appId: 'com.example.notes',
  name: 'Notes',
  version: '1.0.0',
  types: [{ id: 'com.example.notes/note@1', name: 'Note', schema: { text: { kind: 'text' } } }],
  requests: [{ baseId: 'com.example.notes/note', actions: ['create', 'read-any'] }],
};

export const installRequestFixtures: ConformanceFixture<
  WireInstallRequest,
  WireInstallResponse | WireError
>[] = [
  {
    name: 'install-request-pending',
    description:
      'POST /installs with a manifest the owner has not approved for this key answers 202 with ' +
      '{ status: "pending" }. The server queues it for the owner and writes nothing to the ' +
      'stack: a request is not an approval. Sending the same manifest again answers the same ' +
      'way until the owner acts, so re-sending is how an app checks. An upgrade — a manifest ' +
      'adding a version or changing a request — is pending again in the same way.',
    method: 'POST',
    path: '/installs',
    requestBody: { manifest: INSTALL_MANIFEST },
    responseStatus: 202,
    responseBody: { status: 'pending' },
  },
  {
    name: 'install-request-already-installed',
    description:
      'POST /installs with a manifest whose plan for this key is empty — the install is live, ' +
      'the key is linked, and nothing would be added or removed — answers 200 with the ' +
      '_install record. Each linked key holds read on its own install, so the app can fetch ' +
      'it again by id, or find it with a query on the _install family. Assumes the owner ' +
      "approved exactly this manifest for the session's key.",
    method: 'POST',
    path: '/installs',
    requestBody: { manifest: INSTALL_MANIFEST },
    responseStatus: 200,
    responseBody: {
      status: 'installed',
      install: {
        id: '1hk153x00009',
        typeId: '_install@1',
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
        content: {
          appId: 'com.example.notes',
          name: 'Notes',
          version: '1.0.0',
          defines: ['com.example.notes/note@1'],
          requests: [{ baseId: 'com.example.notes/note', actions: ['create', 'read-any'] }],
        },
        version: 1,
      },
    },
  },
  {
    name: 'install-request-type-outside-namespace',
    description:
      "POST /installs whose manifest defines a type outside the app's own namespace answers " +
      '422 with code "validation", naming the type. A family belongs to the app whose appId ' +
      "is its namespace; an app that wants to use another app's family lists it in requests " +
      'instead. See docs/spec/apps.md § Who owns a family.',
    method: 'POST',
    path: '/installs',
    requestBody: {
      manifest: {
        ...INSTALL_MANIFEST,
        types: [{ id: 'com.example.tags/tag@1', name: 'Tag', schema: {} }],
      },
    },
    responseStatus: 422,
    responseBody: {
      error: {
        code: 'validation',
        message: 'Invalid arguments',
        details: [
          {
            path: 'types[0].id',
            message:
              '"com.example.tags/tag" is outside the namespace "com.example.notes"; request ' +
              'access to it instead of defining it',
          },
        ],
      },
    },
  },
  {
    name: 'install-request-key-registered-to-another-app',
    description:
      'POST /installs from a key whose _app card names a different appId answers 409 with ' +
      'code "conflict". One key speaks for one app; a card\'s appId is immutable once set. ' +
      'Assumes the session\'s DID is registered to "com.example.other".',
    method: 'POST',
    path: '/installs',
    requestBody: { manifest: INSTALL_MANIFEST },
    responseStatus: 409,
    responseBody: {
      error: {
        code: 'conflict',
        message:
          'did:key:z6Mkfsz9oK6i2355mvEwtDYdAmqCN6kmQETThJtARfj9iGum is registered to ' +
          '"com.example.other", not "com.example.notes"',
      },
    },
  },
  {
    name: 'install-request-delegated-session',
    description:
      'POST /installs from a delegated session — a principal acting for a subject — answers ' +
      '403 with code "permission". An install is for the key that authenticated, acting as ' +
      'itself; a delegated token names someone else as the subject.',
    method: 'POST',
    path: '/installs',
    requestBody: { manifest: INSTALL_MANIFEST },
    responseStatus: 403,
    responseBody: {
      error: { code: 'permission', message: 'An install request must come from the key itself' },
    },
  },
];
