/**
 * Declared-ceiling pre-checks
 * -------------------------------------------------------
 * Client-side guards against an adapter's declared `limits`. Local
 * adapters declare `null` and skip them entirely; only a server names a
 * ceiling, and its own request-size limit stays authoritative — these just
 * spare an app the round trip and give it a typed failure instead of a 413
 * it has to interpret.
 *
 * See docs/spec/wire-format.md § Request size limits.
 */

import { StackPayloadTooLargeError } from './errors.js';

/** Shared by Stack.putAttachment() and ScopedStack.putAttachment(). */
export function assertAttachmentSize(byteLength: number, attachmentBytes: number | null): void {
  if (attachmentBytes !== null && byteLength > attachmentBytes) {
    throw new StackPayloadTooLargeError(
      `Attachment (${byteLength} bytes) exceeds the ${attachmentBytes}-byte limit.`,
    );
  }
}

/**
 * The content half of the same pre-check, on Stack.create() and
 * Stack.mutate(). Local adapters declare `limits.contentBytes: null` and skip
 * the serialization entirely; only a server declares a ceiling, and its
 * own request-size limit stays authoritative — this just spares an app the
 * round trip and gives it a typed failure instead of a 413 it has to
 * interpret. See docs/spec/wire-format.md § Request size limits.
 */
export function assertContentSize(
  content: Record<string, unknown>,
  contentBytes: number | null,
  what: 'Content' | 'Patch',
): void {
  if (contentBytes === null) return;
  const byteLength = new TextEncoder().encode(JSON.stringify(content)).length;
  if (byteLength > contentBytes) {
    throw new StackPayloadTooLargeError(
      `${what} (${byteLength} bytes) exceeds the ${contentBytes}-byte limit.`,
    );
  }
}
