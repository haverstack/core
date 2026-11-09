import { describe, test, expect } from 'vitest';
import {
  isSafeAttachmentContentType,
  inferContentTypeFromFilename,
  resolveAttachmentDownloadContentType,
  attachmentContentDisposition,
  FORCED_CONTENT_TYPE,
} from '../src/wire/attachment-download.js';
import {
  contentDispositionFilename,
  parseContentDispositionFilename,
} from '../src/wire/content-disposition.js';
import { firstRecordedAttachment, resolveReferencedAttachment } from '../src/attachment-records.js';

// -------------------------------------------------------
// isSafeAttachmentContentType
// -------------------------------------------------------

describe('isSafeAttachmentContentType', () => {
  test.each([
    'image/png',
    'image/jpeg',
    'video/mp4',
    'audio/mpeg',
    'application/pdf',
    'text/plain',
    'application/octet-stream',
  ])('%s is safe', (mimeType) => {
    expect(isSafeAttachmentContentType(mimeType)).toBe(true);
  });

  test.each([
    'text/html',
    'application/xhtml+xml',
    'image/svg+xml',
    'text/javascript',
    'application/javascript',
    'application/xml',
    'text/xml',
    'text/xsl',
  ])('%s is not safe', (mimeType) => {
    expect(isSafeAttachmentContentType(mimeType)).toBe(false);
  });

  test('image/svg+xml is excluded despite matching the image/ prefix', () => {
    expect(isSafeAttachmentContentType('image/svg+xml')).toBe(false);
  });

  test('is case-insensitive', () => {
    expect(isSafeAttachmentContentType('IMAGE/PNG')).toBe(true);
    expect(isSafeAttachmentContentType('TEXT/HTML')).toBe(false);
  });

  test('strips MIME parameters before checking (parameter tricks cannot bypass the safe-list)', () => {
    expect(isSafeAttachmentContentType('text/plain; charset=utf-8')).toBe(true);
    expect(isSafeAttachmentContentType('text/html; charset=utf-7')).toBe(false);
  });

  // A Content-Type header carrying several types is split on commas and
  // resolved to the *last* parsable one, so reading only up to the first
  // `;` would clear a value a browser then resolves as text/html.
  test.each([
    'image/png,text/html',
    'image/png, text/html',
    'audio/mpeg,image/svg+xml',
    'image/png;charset=utf-8,text/html',
  ])('%s is not safe — a multi-type header resolves to its last type', (mimeType) => {
    expect(isSafeAttachmentContentType(mimeType)).toBe(false);
  });

  test.each([
    'image/png\r\nX-Injected: 1',
    'image/png<script>',
    'image/png text/html',
    'image/',
    '/png',
    'image',
    '',
  ])('%j is not a single well-formed MIME type, so it is not safe', (mimeType) => {
    expect(isSafeAttachmentContentType(mimeType)).toBe(false);
  });

  test('well-formed parameters still pass, including a quoted value', () => {
    expect(isSafeAttachmentContentType('image/png; foo="bar;baz"')).toBe(true);
    expect(isSafeAttachmentContentType('  image/png  ')).toBe(true);
  });
});

// -------------------------------------------------------
// inferContentTypeFromFilename
// -------------------------------------------------------

describe('inferContentTypeFromFilename', () => {
  test('infers from a known extension', () => {
    expect(inferContentTypeFromFilename('photo.png')).toBe('image/png');
  });

  test('infers dangerous types too — forcing is applied to the result, not the inference', () => {
    expect(inferContentTypeFromFilename('payload.html')).toBe('text/html');
    expect(inferContentTypeFromFilename('payload.svg')).toBe('image/svg+xml');
  });

  test('is case-insensitive on the extension', () => {
    expect(inferContentTypeFromFilename('photo.PNG')).toBe('image/png');
  });

  test('returns undefined for an unrecognized extension', () => {
    expect(inferContentTypeFromFilename('archive.zip')).toBeUndefined();
  });

  test('returns undefined for a filename with no extension', () => {
    expect(inferContentTypeFromFilename('README')).toBeUndefined();
  });
});

// -------------------------------------------------------
// resolveAttachmentDownloadContentType — source precedence
// -------------------------------------------------------

describe('resolveAttachmentDownloadContentType — source precedence', () => {
  test('?contentType wins over everything else', () => {
    const result = resolveAttachmentDownloadContentType({
      contentTypeParam: 'image/png',
      filenameParam: 'payload.html',
      storedMimeType: 'video/mp4',
    });
    expect(result).toEqual({ contentType: 'image/png', forced: false });
  });

  test('extension inference from ?filename wins when ?contentType is absent', () => {
    const result = resolveAttachmentDownloadContentType({
      filenameParam: 'photo.png',
      storedMimeType: 'video/mp4',
    });
    expect(result).toEqual({ contentType: 'image/png', forced: false });
  });

  test('falls through to stored mimeType when ?filename has no recognized extension', () => {
    const result = resolveAttachmentDownloadContentType({
      filenameParam: 'archive.zip',
      storedMimeType: 'image/png',
    });
    expect(result).toEqual({ contentType: 'image/png', forced: false });
  });

  test('stored mimeType is used when no query params are given', () => {
    const result = resolveAttachmentDownloadContentType({ storedMimeType: 'image/png' });
    expect(result).toEqual({ contentType: 'image/png', forced: false });
  });

  test('falls back to application/octet-stream when nothing is known', () => {
    const result = resolveAttachmentDownloadContentType({});
    expect(result).toEqual({ contentType: FORCED_CONTENT_TYPE, forced: false });
  });
});

// -------------------------------------------------------
// resolveAttachmentDownloadContentType — dangerous-type forcing
// -------------------------------------------------------

describe('resolveAttachmentDownloadContentType — forcing applies to the result, not the source', () => {
  test('forces a dangerous ?contentType param', () => {
    const result = resolveAttachmentDownloadContentType({ contentTypeParam: 'text/html' });
    expect(result).toEqual({ contentType: FORCED_CONTENT_TYPE, forced: true });
  });

  test('forces a dangerous type inferred from ?filename', () => {
    const result = resolveAttachmentDownloadContentType({ filenameParam: 'payload.html' });
    expect(result).toEqual({ contentType: FORCED_CONTENT_TYPE, forced: true });
  });

  test('forces a dangerous stored mimeType (e.g. a lying _attachment@1 record)', () => {
    const result = resolveAttachmentDownloadContentType({ storedMimeType: 'text/html' });
    expect(result).toEqual({ contentType: FORCED_CONTENT_TYPE, forced: true });
  });

  test('forces a multi-type candidate from any source', () => {
    expect(
      resolveAttachmentDownloadContentType({ contentTypeParam: 'image/png,text/html' }),
    ).toEqual({ contentType: FORCED_CONTENT_TYPE, forced: true });
    expect(resolveAttachmentDownloadContentType({ storedMimeType: 'image/png,text/html' })).toEqual(
      { contentType: FORCED_CONTENT_TYPE, forced: true },
    );
  });

  test('a safe type from any source passes through unforced', () => {
    expect(resolveAttachmentDownloadContentType({ contentTypeParam: 'image/png' }).forced).toBe(
      false,
    );
    expect(resolveAttachmentDownloadContentType({ filenameParam: 'photo.png' }).forced).toBe(false);
    expect(resolveAttachmentDownloadContentType({ storedMimeType: 'image/png' }).forced).toBe(
      false,
    );
  });
});

// -------------------------------------------------------
// firstRecordedAttachment — which record establishes the mimeType
// -------------------------------------------------------

describe('firstRecordedAttachment', () => {
  const rec = (id: string, createdAt: string) => ({ id, createdAt: new Date(createdAt) });

  test('the earliest createdAt wins', () => {
    const first = rec('b', '2024-01-01T00:00:00.000Z');
    const later = rec('a', '2024-06-01T00:00:00.000Z');

    expect(firstRecordedAttachment([later, first])?.id).toBe('b');
  });

  // The case the write-time conflict check can't prevent: two uploads of
  // the same bytes racing on a concurrent server both find nothing and
  // both land, possibly within the same millisecond. Determinism can't
  // depend on that never happening, so it depends on the tiebreak instead.
  test('a createdAt tie is broken by the lower id', () => {
    const sameInstant = '2024-01-01T00:00:00.000Z';
    const records = [rec('1hk153x00002', sameInstant), rec('1hk153x00001', sameInstant)];

    expect(firstRecordedAttachment(records)?.id).toBe('1hk153x00001');
    expect(firstRecordedAttachment([...records].reverse())?.id).toBe('1hk153x00001');
  });

  test('the answer does not depend on the order records arrive in', () => {
    const records = [
      rec('c', '2024-01-01T00:00:00.000Z'),
      rec('a', '2024-01-01T00:00:00.000Z'),
      rec('b', '2023-12-31T23:59:59.999Z'),
    ];

    for (const permutation of [
      records,
      [...records].reverse(),
      [records[1], records[2], records[0]],
    ]) {
      expect(firstRecordedAttachment(permutation)?.id).toBe('b');
    }
  });

  test('no records means nothing is established yet', () => {
    expect(firstRecordedAttachment([])).toBeUndefined();
  });
});

// -------------------------------------------------------
// resolveReferencedAttachment
// -------------------------------------------------------

describe('resolveReferencedAttachment', () => {
  const rec = (id: string, createdAt: string, subjectId?: string) => ({
    id,
    createdAt: new Date(createdAt),
    ...(subjectId && { createdBy: { subjectId } }),
  });

  const uploads = [
    rec('1hk153x00001', '2024-01-01T00:00:00.000Z', 'did:key:alice'),
    rec('1hk153x00002', '2024-06-01T00:00:00.000Z', 'did:key:bob'),
  ];

  test('the named record wins over the requester and the earliest', () => {
    expect(
      resolveReferencedAttachment(uploads, {
        attachmentRecordId: '1hk153x00002',
        requesterEntityId: 'did:key:alice',
      })?.id,
    ).toBe('1hk153x00002');
  });

  test("the requester's own upload wins when no record is named", () => {
    expect(resolveReferencedAttachment(uploads, { requesterEntityId: 'did:key:bob' })?.id).toBe(
      '1hk153x00002',
    );
  });

  test('the first-recorded record answers a reference naming neither', () => {
    expect(resolveReferencedAttachment(uploads)?.id).toBe('1hk153x00001');
    expect(resolveReferencedAttachment(uploads, { requesterEntityId: 'did:key:carol' })?.id).toBe(
      '1hk153x00001',
    );
  });

  // The pointer is best-effort: the record it names can be deleted, and an
  // unscoped upload has no author to match either.
  test('a pointer at a record that is gone falls back', () => {
    expect(
      resolveReferencedAttachment(uploads, {
        attachmentRecordId: 'deleted00001',
        requesterEntityId: 'did:key:bob',
      })?.id,
    ).toBe('1hk153x00002');
    expect(resolveReferencedAttachment(uploads, { attachmentRecordId: 'deleted00001' })?.id).toBe(
      '1hk153x00001',
    );
  });

  test("the requester's earliest upload wins among several of their own", () => {
    const mine = [
      rec('1hk153x00003', '2024-09-01T00:00:00.000Z', 'did:key:bob'),
      ...uploads,
      rec('1hk153x00004', '2024-03-01T00:00:00.000Z', 'did:key:bob'),
    ];

    expect(resolveReferencedAttachment(mine, { requesterEntityId: 'did:key:bob' })?.id).toBe(
      '1hk153x00004',
    );
  });

  test('no records means nothing to resolve', () => {
    expect(resolveReferencedAttachment([], { attachmentRecordId: '1hk153x00001' })).toBeUndefined();
  });
});

// -------------------------------------------------------
// attachmentContentDisposition
// -------------------------------------------------------

describe('attachmentContentDisposition', () => {
  test('with no filename, the disposition stands alone', () => {
    expect(attachmentContentDisposition({ forced: true })).toBe('attachment');
    expect(attachmentContentDisposition({ forced: false })).toBe('inline');
    expect(attachmentContentDisposition({ forced: false, filename: '' })).toBe('inline');
  });

  test('a filename never changes the disposition', () => {
    expect(attachmentContentDisposition({ forced: true, filename: 'a.png' })).toMatch(
      /^attachment;/,
    );
    expect(attachmentContentDisposition({ forced: false, filename: 'a.png' })).toMatch(/^inline;/);
  });

  test('a plain name appears in both forms', () => {
    expect(attachmentContentDisposition({ forced: true, filename: 'payload.html' })).toBe(
      `attachment; filename="payload.html"; filename*=UTF-8''payload.html`,
    );
  });

  test.each([
    ["a\"; filename*=UTF-8''evil.html", "a_; filename*=UTF-8''evil.html"],
    ['line\r\nSet-Cookie: x=1', 'line__Set-Cookie: x=1'],
    ['back\\slash', 'back_slash'],
    ['café.png', 'caf_.png'],
    ['party🎉.png', 'party_.png'],
  ])('%j cannot escape the quoted fallback', (filename, fallback) => {
    const header = attachmentContentDisposition({ forced: true, filename });
    expect(header).not.toMatch(/[\r\n]/);
    const [, quoted, ext] = /^attachment; filename="([^"]*)"; filename\*=UTF-8''(\S+)$/.exec(
      header,
    )!;
    expect(quoted).toBe(fallback);
    expect(ext).toMatch(/^[A-Za-z0-9%._~-]+$/);
    expect(decodeURIComponent(ext)).toBe(filename);
  });
});

describe('contentDispositionFilename', () => {
  test.each(['photo.png', "it's (a) *note*!.txt", 'café.png', 'a"b\\c.txt', 'line\r\nbreak'])(
    '%j survives the round trip through parseContentDispositionFilename()',
    (filename) => {
      expect(
        parseContentDispositionFilename(`attachment; ${contentDispositionFilename(filename)}`),
      ).toBe(filename);
    },
  );
});
