/**
 * Scoped cursor sealing
 * -------------------------------------------------------
 * An adapter's cursor names where the next page resumes: the last record a
 * page scanned, by ID and sort value. A scoped query scans records its
 * requester cannot read, so the cursor it would hand back can name one of
 * them — its ID, its creation time, or the very content field the query
 * sorts by. And a cursor a requester could write would let it choose where
 * a scan starts, which over a content sort is a search over values it
 * cannot read.
 *
 * So ScopedStack never returns an adapter cursor: it seals each one under
 * a key only the stack holds (AES-GCM, authenticated, so a forged or
 * altered cursor is refused rather than resumed), and opens only cursors
 * it sealed. The seal is bound to the requester and the query's filter
 * and sort, so a cursor resumes only the query that produced it: carried
 * into a broader one, a position on a withheld record could be compared
 * against values the requester chose. The key is `_config.cursorKey`,
 * written when `_config` is, so a cursor outlives the process that minted
 * it and resumes on any instance serving the same stack.
 *
 * See docs/spec/disclosure.md § Scoped cursors are sealed.
 */

import { StackBadRequestError } from '../errors.js';
import { base64urlDecode, base64urlEncode } from '../wire/auth.js';

/** AES-256: the key is 32 bytes, stored base64url-encoded. */
const KEY_BYTES = 32;
/** AES-GCM's standard nonce length; a fresh one is drawn per seal. */
const IV_BYTES = 12;
/** The authentication tag AES-GCM appends to every ciphertext. */
const TAG_BYTES = 16;

/**
 * What a sealed cursor is bound to: who asked, and which records in which
 * order. Keys are sorted, so the same query spelled in another key order
 * binds alike; `limit` is left out, since a caller may page at any size.
 */
export const cursorContext = (
  requester: { principalId: string | null; subjectId: string | null },
  query: { filter?: unknown; sort?: unknown },
): string => canonicalJson({ requester, filter: query.filter ?? null, sort: query.sort ?? null });

const canonicalJson = (value: unknown): string =>
  JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );

/** A fresh `_config.cursorKey`. */
export const generateCursorKey = (): string =>
  base64urlEncode(crypto.getRandomValues(new Uint8Array(KEY_BYTES)));

/** Why a value cannot be a `_config.cursorKey`, or null when it can. */
export const cursorKeyProblem = (value: unknown): string | null => {
  if (typeof value !== 'string') return 'cursorKey must be a string';
  try {
    if (base64urlDecode(value).length === KEY_BYTES) return null;
  } catch {
    // Reported below with the same message as a wrong length.
  }
  return `cursorKey must be ${KEY_BYTES} bytes, base64url-encoded`;
};

export class CursorSeal {
  private constructor(private readonly key: CryptoKey) {}

  /** Import a stored `_config.cursorKey`, which its write already checked. */
  static async fromKey(encoded: string): Promise<CursorSeal> {
    const key = await crypto.subtle.importKey(
      'raw',
      new Uint8Array(base64urlDecode(encoded)),
      'AES-GCM',
      false,
      ['encrypt', 'decrypt'],
    );
    return new CursorSeal(key);
  }

  async seal(cursor: string, context: string): Promise<string> {
    const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
    const sealed = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(context) },
        this.key,
        new TextEncoder().encode(cursor),
      ),
    );
    const out = new Uint8Array(IV_BYTES + sealed.length);
    out.set(iv, 0);
    out.set(sealed, IV_BYTES);
    return base64urlEncode(out);
  }

  /**
   * The adapter cursor inside a sealed one. Anything this stack did not
   * seal for `context` is malformed, the same 400 an adapter gives a
   * cursor it cannot decode.
   */
  async open(sealed: string, context: string): Promise<string> {
    const malformed = () => new StackBadRequestError(`Invalid cursor: malformed "${sealed}"`);
    let bytes: Uint8Array;
    try {
      bytes = base64urlDecode(sealed);
    } catch {
      throw malformed();
    }
    if (bytes.length < IV_BYTES + TAG_BYTES) throw malformed();
    try {
      const plain = await crypto.subtle.decrypt(
        {
          name: 'AES-GCM',
          iv: bytes.slice(0, IV_BYTES),
          additionalData: new TextEncoder().encode(context),
        },
        this.key,
        bytes.slice(IV_BYTES),
      );
      return new TextDecoder().decode(plain);
    } catch {
      throw malformed();
    }
  }
}
