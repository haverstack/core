import type { WireRecord, WireError } from '@haverstack/wire-types';

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
      '(exposed ahead of time as limits.attachmentBytes in discovery — see docs/spec/wire-format.md § Discovery) ' +
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
