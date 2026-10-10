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
   * A trailing `\r` held until the next chunk. A chunk boundary can split a
   * CRLF, and normalizing the lone CR would let the next chunk's `\n` close
   * a spurious blank line, cutting one frame in two. The next chunk decides
   * whether it was half a CRLF or a line ending of its own.
   */
  private pendingCr = false;

  push(chunk: string): SseFrame[] {
    let text = this.pendingCr ? '\r' + chunk : chunk;
    this.pendingCr = false;
    if (text.endsWith('\r')) {
      this.pendingCr = true;
      text = text.slice(0, -1);
    }
    this.buffer += text.replace(/\r\n|\r/g, '\n');
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
