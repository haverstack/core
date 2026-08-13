/**
 * Stack — Attachment Download Content-Type Resolution
 * -------------------------------------------------------
 * Shared, pure implementation of the `GET /attachments/:fileId` dangerous-
 * type policy (docs/spec/wire-format.md § Download). Core has no HTTP
 * server of its own — this module exists so `haverstack/server` and any
 * other server implementation share one safe-list and one forcing
 * computation, rather than each re-deriving it and risking drift on a
 * security-relevant policy (the same "written once, not a per-server
 * convention" principle applied elsewhere to adapter invariants).
 *
 * The policy is result-not-source: `resolveAttachmentDownloadContentType()`
 * computes a single candidate type from whichever source wins (explicit
 * param, then filename extension, then stored metadata, then
 * application/octet-stream) and applies the safe-list to *that value* —
 * never to the source that produced it, so no source can route a
 * dangerous type past the check.
 */

/** MIME types that pass through unforced, regardless of source. */
const SAFE_EXACT_TYPES = new Set(['application/pdf', 'text/plain', 'application/octet-stream']);

/** MIME type prefixes that pass through unforced, except for UNSAFE_OVERRIDES below. */
const SAFE_PREFIXES = ['image/', 'video/', 'audio/'];

/**
 * Matches a SAFE_PREFIXES entry but is script-capable and must still be
 * forced — image/svg+xml is the reason a plain prefix check isn't enough.
 */
const UNSAFE_OVERRIDES = new Set(['image/svg+xml']);

/** application/octet-stream: the forced replacement for any unsafe type. */
export const FORCED_CONTENT_TYPE = 'application/octet-stream';

export const NOSNIFF_HEADER_NAME = 'X-Content-Type-Options';
export const NOSNIFF_HEADER_VALUE = 'nosniff';

/** Strips MIME parameters ("text/html; charset=utf-8" -> "text/html") and lowercases, so parameter tricks and casing can't bypass the safe-list check. */
function normalizeMimeType(mimeType: string): string {
  return mimeType.split(';')[0].trim().toLowerCase();
}

/**
 * Whether a MIME type may be served as-is (Content-Type set to it, no
 * forced download). Checked against the normalized base type — any
 * parameters or casing on the input don't affect the result.
 */
export function isSafeAttachmentContentType(mimeType: string): boolean {
  const normalized = normalizeMimeType(mimeType);
  if (UNSAFE_OVERRIDES.has(normalized)) return false;
  if (SAFE_EXACT_TYPES.has(normalized)) return true;
  return SAFE_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

/**
 * Extension -> candidate MIME type, used only when resolving from a
 * `?filename` param with no explicit `?contentType` (spec: extension
 * inference). Deliberately includes dangerous types (html, svg, js, xml)
 * — forcing applies to the computed candidate, not to how it was computed,
 * so listing them here is what lets the safe-list catch them.
 */
const EXTENSION_MIME_TYPES: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  avif: 'image/avif',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  pdf: 'application/pdf',
  txt: 'text/plain',
  html: 'text/html',
  htm: 'text/html',
  xhtml: 'application/xhtml+xml',
  svg: 'image/svg+xml',
  js: 'text/javascript',
  mjs: 'text/javascript',
  xml: 'application/xml',
  xsl: 'text/xsl',
};

/** Infers a candidate MIME type from a filename's extension. Returns undefined for no extension or an unrecognized one — the caller falls through to the next source. */
export function inferContentTypeFromFilename(filename: string): string | undefined {
  const match = /\.([a-z0-9]+)$/i.exec(filename);
  return match ? EXTENSION_MIME_TYPES[match[1].toLowerCase()] : undefined;
}

/**
 * Which `_attachment@1` record establishes a fileId's mimeType — the
 * "first-recorded" rule of docs/spec/attachments.md, as a total order:
 * earliest `createdAt`, ties broken by the lower `id`.
 *
 * The tiebreak is what makes it a rule rather than a coincidence of scan
 * order. Rejecting a conflicting mimeType at write time is check-then-act
 * with no storage-level uniqueness behind it, so two racing first uploads
 * of the same bytes can both land on a concurrent server. Determinism
 * doesn't depend on that never happening — it depends on every reader
 * ordering the records the same way, which is why core's write-time
 * conflict check and a server's serving choice both come through here.
 *
 * Generic over the record shape so a server can pass its own row type.
 * Records for other fileIds must be filtered out by the caller.
 */
export function firstRecordedAttachment<T extends { id: string; createdAt: Date }>(
  records: readonly T[],
): T | undefined {
  return records.reduce<T | undefined>((first, record) => {
    if (!first) return record;
    const delta = record.createdAt.getTime() - first.createdAt.getTime();
    if (delta !== 0) return delta < 0 ? record : first;
    return record.id < first.id ? record : first;
  }, undefined);
}

export type AttachmentDownloadContentType = {
  /** The Content-Type header value to serve. */
  contentType: string;
  /**
   * Whether the dangerous-type policy overrode the candidate. When true,
   * the server MUST also force `Content-Disposition: attachment` — Content-
   * Type forcing alone doesn't stop a browser from sniffing the body back
   * into the original type without both nosniff (always required, see
   * NOSNIFF_HEADER_NAME/VALUE) and a non-inline disposition.
   */
  forced: boolean;
};

/**
 * Resolve the Content-Type served for `GET /attachments/:fileId`
 * (docs/spec/wire-format.md § Download): `?contentType` wins, else
 * extension inference from `?filename`, else the stored mimeType, else
 * `application/octet-stream` — then the safe-list is applied to whichever
 * candidate that produced.
 */
export function resolveAttachmentDownloadContentType(input: {
  contentTypeParam?: string;
  filenameParam?: string;
  storedMimeType?: string;
}): AttachmentDownloadContentType {
  const candidate =
    input.contentTypeParam ||
    (input.filenameParam && inferContentTypeFromFilename(input.filenameParam)) ||
    input.storedMimeType ||
    FORCED_CONTENT_TYPE;

  return isSafeAttachmentContentType(candidate)
    ? { contentType: candidate, forced: false }
    : { contentType: FORCED_CONTENT_TYPE, forced: true };
}
