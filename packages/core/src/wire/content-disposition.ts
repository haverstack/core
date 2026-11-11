/**
 * Stack — Attachment filenames in `Content-Disposition`
 * -------------------------------------------------------
 * The filename an upload carries and a download is served with is text
 * someone other than the writer chose, landing in a header. Both
 * directions use the one encoding here, and its parser beside it, so a
 * client, a server and core cannot each spell it their own way.
 * See docs/spec/wire-format.md § Attachments.
 */

/**
 * Anything a quoted `filename="…"` cannot carry verbatim: controls,
 * non-ASCII, `"` and `\\`. Per code point, so one emoji is one `_`.
 */
const UNQUOTABLE_RE = /[^\x20-\x7e]|["\\]/gu;

/** RFC 8187 value-chars: encodeURIComponent() leaves `'()*` bare, which `attr-char` does not admit. */
const encodeExtValue = (value: string): string =>
  encodeURIComponent(value).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );

/**
 * The filename parameters of a `Content-Disposition`: a quoted ASCII
 * fallback with every unquotable character replaced, and the exact name as
 * an RFC 8187 `filename*`, which a reader prefers. parseContentDispositionFilename() is
 * its inverse.
 */
export function contentDispositionFilename(filename: string): string {
  const fallback = filename.replace(UNQUOTABLE_RE, '_');
  return `filename="${fallback}"; filename*=UTF-8''${encodeExtValue(filename)}`;
}

/**
 * Read a filename from a `Content-Disposition`. Prefers the RFC 8187
 * extended form (`filename*=UTF-8''name.txt`), which carries the exact
 * name, and falls back to the plain quoted form. Only a UTF-8 `filename*`
 * is decoded, since percent-decoding reads UTF-8; another charset falls
 * back too.
 */
export function parseContentDispositionFilename(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const extended = /filename\*\s*=\s*utf-8'[^']*'([^;]+)/i.exec(header);
  if (extended) {
    try {
      return decodeURIComponent(extended[1].trim());
    } catch {
      // Malformed percent-encoding — fall through to the plain form.
    }
  }
  const plain = /filename\s*=\s*"([^"]+)"/i.exec(header);
  return plain ? plain[1] : undefined;
}
