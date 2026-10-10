/**
 * Server-sent events decoder
 * -------------------------------------------------------
 * The change feed's `text/event-stream` framing, decoded independently of
 * the connection carrying it. See docs/spec/change-feed.md.
 */

import { APIAdapterError } from './errors.js';

/** One decoded SSE frame. `event` defaults to the protocol's own default. */
export type SseFrame = { id?: string; event: string; data: string };

/**
 * Incremental SSE decoder: text in, whole frames out, holding a partial
 * frame until the blank line that ends it. Chunk boundaries fall wherever
 * the network puts them, so a frame arriving in three pieces has to
 * decode identically to one arriving whole.
 */
export class SseDecoder {
  private buffer = '';
  /**
   * A trailing `\r` held back from normalization. SSE line endings are CR,
   * LF, or CRLF, and a chunk boundary can fall between the CR and the LF of
   * a CRLF: normalizing per chunk would turn that lone CR into a `\n` and
   * the next chunk's leading `\n` would complete a spurious `\n\n`, cutting
   * one frame into two. Holding the CR until the next chunk decides whether
   * it is half a CRLF (drop the following `\n`) or a lone CR (its own line
   * separator) makes a frame split anywhere decode as one arriving whole.
   */
  private pendingCr = false;

  push(chunk: string): SseFrame[] {
    let text = this.pendingCr ? '\r' + chunk : chunk;
    this.pendingCr = false;
    // A trailing CR might be the first half of a CRLF split across chunks;
    // hold it until the next push (or the stream's end) resolves it.
    if (text.endsWith('\r')) {
      this.pendingCr = true;
      text = text.slice(0, -1);
    }
    this.buffer += text.replace(/\r\n|\r/g, '\n');
    // A frame with no terminating blank line grows the buffer without
    // bound; a peer that never closes one would otherwise exhaust memory.
    if (this.buffer.length > MAX_SSE_BUFFER_BYTES) {
      throw new APIAdapterError(
        `Change feed frame exceeded ${MAX_SSE_BUFFER_BYTES} bytes without a frame boundary.`,
      );
    }
    const frames: SseFrame[] = [];
    let boundary = this.buffer.indexOf('\n\n');
    while (boundary !== -1) {
      const block = this.buffer.slice(0, boundary);
      this.buffer = this.buffer.slice(boundary + 2);
      const frame = decodeFrame(block);
      if (frame) frames.push(frame);
      boundary = this.buffer.indexOf('\n\n');
    }
    return frames;
  }
}

/**
 * How large a single unterminated SSE frame may grow before the connection
 * is abandoned. Generous next to any real change frame — a record body is
 * bounded by the server's own content limit — but finite, so a peer that
 * streams without ever closing a frame cannot exhaust client memory.
 */
const MAX_SSE_BUFFER_BYTES = 8 * 1024 * 1024;

/** Null for a block carrying only comments — a keepalive is not a frame. */
function decodeFrame(block: string): SseFrame | null {
  let id: string | undefined;
  let event: string | undefined;
  const data: string[] = [];

  for (const line of block.split('\n')) {
    // A line opening with a colon is a comment. Keepalives arrive as one,
    // and exist so an idle connection is distinguishable from a dead one.
    if (line === '' || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'id') id = value;
    else if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
  }

  if (id === undefined && event === undefined && data.length === 0) return null;
  return { ...(id !== undefined && { id }), event: event ?? 'message', data: data.join('\n') };
}
