import type { DiscoveryResponse } from '@haverstack/wire-types';
import { WIRE_PROTOCOL_VERSION } from '@haverstack/wire-types';
import type { ConformanceFixture } from './types.js';

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
        filter: {
          content: 'path',
          contentPresent: true,
          search: true,
        },
        sort: {
          fields: ['createdAt', 'updatedAt', 'version'],
          contentField: true,
        },
        limits: {
          attachmentBytes: 52428800,
          contentBytes: 1048576,
        },
      },
    },
  },
  {
    name: 'discovery-advertises-install-requests',
    description:
      'A server that takes install requests says so with installs.requests: true. Absent ' +
      'means it does not, and a client refuses requestInstall() locally rather than learning ' +
      'it as a 404 — see docs/spec/wire-format.md § Installs.',
    method: 'GET',
    path: '/.well-known/stack',
    responseStatus: 200,
    responseBody: {
      version: WIRE_PROTOCOL_VERSION,
      entityId: 'did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK',
      capabilities: {
        filter: { content: 'none', contentPresent: false, search: false },
        sort: { fields: ['createdAt', 'updatedAt', 'version'], contentField: false },
        limits: { attachmentBytes: null, contentBytes: null },
      },
      installs: { requests: true },
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
        filter: {
          content: 'none',
          contentPresent: false,
          search: false,
        },
        sort: {
          fields: ['createdAt'],
          contentField: false,
        },
        limits: {
          attachmentBytes: null,
          contentBytes: null,
        },
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
        filter: {
          content: 'path',
          contentPresent: true,
          search: true,
        },
        sort: {
          fields: ['createdAt', 'updatedAt', 'version'],
          contentField: true,
        },
        limits: {
          attachmentBytes: 52428800,
          contentBytes: 1048576,
        },
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
        filter: {
          content: 'path',
          contentPresent: true,
          search: true,
        },
        sort: {
          fields: ['createdAt', 'updatedAt', 'version'],
          contentField: true,
        },
        limits: {
          attachmentBytes: 52428800,
          contentBytes: 1048576,
        },
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
        filter: {
          content: 'none',
          contentPresent: false,
          search: false,
        },
        sort: {
          fields: ['createdAt'],
          contentField: false,
        },
        limits: {
          attachmentBytes: null,
          contentBytes: null,
        },
      },
      changes: { transports: ['sse'], resume: false, records: false },
    },
  },
];
