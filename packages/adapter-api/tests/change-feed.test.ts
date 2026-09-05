/**
 * The change feed over the wire: what APIAdapter sends to open one, what
 * it makes of the frames that come back, and what it does when the stream
 * ends. See docs/spec/change-feed.md.
 */
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  APIAdapter,
  APIAdapterCapabilityError,
  APIAdapterError,
  APIAdapterAuthError,
} from '../src/index.js';
import { WIRE_PROTOCOL_VERSION } from '@haverstack/wire-types';
import { StackQueryError, StackTimeoutError } from '@haverstack/core';
import type { RecordChange } from '@haverstack/core';

const BASE_URL = 'https://stack.example.com';
const TOKEN = 'test-token-abc';
const OWNER = 'entity-owner-123';
const EDITOR = 'did:key:zEditor';

const DISCOVERY = {
  version: WIRE_PROTOCOL_VERSION,
  entityId: OWNER,
  capabilities: {
    fullTextSearch: true,
    contentFieldQuery: true,
    nestedContentQuery: true,
    contentFieldSort: true,
    sortableFields: ['createdAt'],
    maxAttachmentBytes: null,
    maxContentBytes: null,
  },
  changes: { transports: ['sse'], resume: true, records: true },
};

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/**
 * A stream a test drives frame by frame, standing in for a connection the
 * server holds open. `end()` closes it the way a server closing the
 * connection does — an ordinary event the adapter answers by reconnecting.
 */
const feed = () => {
  let controller: ReadableStreamDefaultController<Uint8Array>;
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  return {
    response: new Response(body, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    }),
    /** Write raw stream text, so a test can split a frame however it likes. */
    write: (text: string) => controller.enqueue(encoder.encode(text)),
    end: () => controller.close(),
  };
};

const READY = 'event: ready\ndata: {"seq":"AA3f1Q"}\n\n';

const recordFrame = (id: string, change: Record<string, unknown>): string =>
  `id: ${id}\nevent: record\ndata: ${JSON.stringify(change)}\n\n`;

const CHANGED = {
  kind: 'changed',
  op: 'update',
  recordId: '1hk153x00001',
  typeId: 'com.example/note@1',
  version: 7,
  updatedAt: '2026-08-13T12:00:00.000Z',
  actor: { entityId: EDITOR },
};

let mockFetch: ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockFetch = vi.fn();
  vi.stubGlobal('fetch', mockFetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const openAdapter = async (discovery: object = DISCOVERY): Promise<APIAdapter> => {
  mockFetch.mockResolvedValueOnce(jsonResponse(discovery));
  return APIAdapter.open({ url: BASE_URL, token: TOKEN });
};

/** The RequestInit of the nth fetch, for asserting headers and signals. */
const requestInit = (n: number): RequestInit => mockFetch.mock.calls[n]![1] as RequestInit;
const headersOf = (n: number): Record<string, string> =>
  requestInit(n).headers as Record<string, string>;

describe('the discovery gate', () => {
  test('refuses a server advertising no feed, without sending a request', async () => {
    const { changes, ...noFeed } = DISCOVERY;
    void changes;
    const adapter = await openAdapter(noFeed);
    const before = mockFetch.mock.calls.length;

    await expect(adapter.subscribeChanges({}, () => {})).rejects.toBeInstanceOf(
      APIAdapterCapabilityError,
    );
    // Learning this as a 404 partway through a connection is the failure
    // discovery exists to prevent, so nothing may go out.
    expect(mockFetch.mock.calls.length).toBe(before);
  });

  test('names the feed as the capability that is missing', async () => {
    const { changes, ...noFeed } = DISCOVERY;
    void changes;
    const adapter = await openAdapter(noFeed);

    await expect(adapter.subscribeChanges({}, () => {})).rejects.toMatchObject({
      capability: 'changes',
    });
  });

  test('accepts a feed that neither resumes nor includes records', async () => {
    const adapter = await openAdapter({
      ...DISCOVERY,
      changes: { transports: ['sse'], resume: false, records: false },
    });
    const stream = feed();
    mockFetch.mockResolvedValueOnce(stream.response);

    const subscription = adapter.subscribeChanges({}, () => {});
    stream.write(READY);
    const stop = await subscription;

    expect(stop).toBeTypeOf('function');
    stop();
  });
});

describe('the resume-cursor gate', () => {
  test('refuses a since outside the seq charset, without sending a request', async () => {
    const adapter = await openAdapter();
    const before = mockFetch.mock.calls.length;

    // A cursor becomes a Last-Event-ID header; one carrying a newline would
    // span the header line, so it is refused locally, not handed to fetch.
    await expect(
      adapter.subscribeChanges({ since: 'AA3f1Q\r\nX-Injected: 1' }, () => {}),
    ).rejects.toBeInstanceOf(APIAdapterError);
    expect(mockFetch.mock.calls.length).toBe(before);
  });
});

describe('opening a connection', () => {
  test('asks for a stream, and resolves only once ready arrives', async () => {
    const adapter = await openAdapter();
    const stream = feed();
    mockFetch.mockResolvedValueOnce(stream.response);

    let live = false;
    const subscription = adapter
      .subscribeChanges({}, () => {})
      .then((stop) => {
        live = true;
        return stop;
      });

    await Promise.resolve();
    // Subscribe-then-query is only gap-free if this waits for ready.
    expect(live).toBe(false);

    stream.write(READY);
    const stop = await subscription;

    expect(mockFetch.mock.calls[1]![0]).toBe(`${BASE_URL}/changes`);
    expect(headersOf(1)['Accept']).toBe('text/event-stream');
    expect(headersOf(1)['Authorization']).toBe(`Bearer ${TOKEN}`);
    expect(headersOf(1)['Last-Event-ID']).toBeUndefined();
    stop();
  });

  test('sends the filter and include as query parameters', async () => {
    const adapter = await openAdapter();
    const stream = feed();
    mockFetch.mockResolvedValueOnce(stream.response);

    const subscription = adapter.subscribeChanges(
      {
        filter: {
          typeId: ['com.example/note@1', 'com.example/memo@1'],
          parentId: null,
          entityId: EDITOR,
          kinds: ['created', 'purged'],
        },
        includeRecords: true,
      },
      () => {},
    );
    stream.write(READY);
    const stop = await subscription;

    const url = new URL(mockFetch.mock.calls[1]![0] as string);
    expect(url.pathname).toBe('/changes');
    expect(url.searchParams.getAll('typeId')).toEqual(['com.example/note@1', 'com.example/memo@1']);
    expect(url.searchParams.get('parentId')).toBe('null');
    expect(url.searchParams.get('entityId')).toBe(EDITOR);
    expect(url.searchParams.getAll('kind')).toEqual(['created', 'purged']);
    expect(url.searchParams.get('include')).toBe('record');
    stop();
  });

  test('presents a cursor it was given as Last-Event-ID', async () => {
    const adapter = await openAdapter();
    const stream = feed();
    mockFetch.mockResolvedValueOnce(stream.response);

    const subscription = adapter.subscribeChanges({ since: 'AA3f1R' }, () => {});
    stream.write(READY);
    const stop = await subscription;

    expect(headersOf(1)['Last-Event-ID']).toBe('AA3f1R');
    stop();
  });

  test('rejects when the first connection never comes up', async () => {
    const adapter = await openAdapter();
    mockFetch.mockResolvedValueOnce(jsonResponse({ error: { code: 'permission' } }, 403));

    await expect(adapter.subscribeChanges({}, () => {})).rejects.toThrow();
  });
});

describe('frames', () => {
  const subscribe = async (
    opts: Parameters<APIAdapter['subscribeChanges']>[0] = {},
  ): Promise<{
    adapter: APIAdapter;
    stream: ReturnType<typeof feed>;
    seen: RecordChange[];
    stop: () => void;
  }> => {
    const adapter = await openAdapter();
    const stream = feed();
    mockFetch.mockResolvedValueOnce(stream.response);
    const seen: RecordChange[] = [];
    const subscription = adapter.subscribeChanges(opts, (c) => void seen.push(c));
    stream.write(READY);
    return { adapter, stream, seen, stop: await subscription };
  };

  test('parses a record frame into a change, with dates as dates', async () => {
    const { stream, seen, stop } = await subscribe();

    stream.write(recordFrame('AA3f1R', CHANGED));
    await vi.waitFor(() => expect(seen).toHaveLength(1));

    expect(seen[0]).toMatchObject({
      kind: 'changed',
      op: 'update',
      recordId: '1hk153x00001',
      version: 7,
      actor: { entityId: EDITOR },
    });
    expect(seen[0]!.updatedAt).toBeInstanceOf(Date);
    expect(seen[0]!.updatedAt.toISOString()).toBe('2026-08-13T12:00:00.000Z');
    stop();
  });

  test('parses the record body when the frame carries one', async () => {
    const { stream, seen, stop } = await subscribe({ includeRecords: true });

    stream.write(
      recordFrame('AA3f1R', {
        ...CHANGED,
        record: {
          id: '1hk153x00001',
          typeId: 'com.example/note@1',
          createdAt: '2026-08-01T00:00:00.000Z',
          updatedAt: '2026-08-13T12:00:00.000Z',
          content: { title: 'Hello' },
          version: 7,
        },
      }),
    );
    await vi.waitFor(() => expect(seen).toHaveLength(1));

    expect(seen[0]!.record).toMatchObject({ id: '1hk153x00001', version: 7 });
    expect(seen[0]!.record!.createdAt).toBeInstanceOf(Date);
    stop();
  });

  // A conformant server sends neither on a purge. Dropping them here means
  // a server that does cannot hand a subscriber the copy of the record the
  // verb exists to destroy.
  test('drops a record and parent a purge frame should never have carried', async () => {
    const { stream, seen, stop } = await subscribe({ includeRecords: true });

    stream.write(
      recordFrame('AA3f1S', {
        kind: 'purged',
        op: 'hard-delete',
        recordId: '1hk153x00002',
        typeId: 'com.example/note@1',
        version: 4,
        updatedAt: '2026-08-13T12:00:03.000Z',
        actor: { entityId: OWNER },
        parentId: '1hk153x00000',
        record: { id: '1hk153x00002', content: { secret: 'erased' } },
      }),
    );
    await vi.waitFor(() => expect(seen).toHaveLength(1));

    expect(seen[0]).not.toHaveProperty('record');
    expect(seen[0]).not.toHaveProperty('parentId');
    expect(seen[0]!.actor).toEqual({ entityId: OWNER });
    stop();
  });

  test('decodes a frame split across chunk boundaries', async () => {
    const { stream, seen, stop } = await subscribe();
    const whole = recordFrame('AA3f1R', CHANGED);

    stream.write(whole.slice(0, 12));
    stream.write(whole.slice(12, 40));
    stream.write(whole.slice(40));
    await vi.waitFor(() => expect(seen).toHaveLength(1));

    expect(seen[0]!.recordId).toBe('1hk153x00001');
    stop();
  });

  // CRLF is a legal SSE line ending, and a chunk boundary can fall between
  // the CR and the LF. Normalizing per chunk would split one frame into two
  // and hand the record half an empty data field; the decoder must hold the
  // trailing CR until the next chunk resolves it.
  test('decodes a CRLF frame split between the CR and the LF', async () => {
    const { stream, seen, stop } = await subscribe();
    const crlf = `id: AA3f1R\r\nevent: record\r\ndata: ${JSON.stringify(CHANGED)}\r\n\r\n`;
    const cut = crlf.indexOf('\r\n', crlf.indexOf('event')) + 1; // just after a CR

    stream.write(crlf.slice(0, cut));
    stream.write(crlf.slice(cut));
    await vi.waitFor(() => expect(seen).toHaveLength(1));

    expect(seen[0]!.recordId).toBe('1hk153x00001');
    expect(seen[0]!.version).toBe(7);
    stop();
  });

  // A single unparseable record frame is a server defect, not a dead
  // connection: it goes to onError and the reader carries on to the next
  // frame rather than tearing the stream down and reconnecting into it.
  test('reports an unparseable record frame and keeps reading', async () => {
    const onError = vi.fn();
    const { stream, seen, stop } = await subscribe({ onError });

    stream.write('id: AA3f1R\nevent: record\ndata: {not json\n\n');
    await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());
    expect(seen).toHaveLength(0);

    stream.write(recordFrame('AA3f1S', CHANGED));
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    expect(seen[0]!.recordId).toBe('1hk153x00001');
    stop();
  });

  test('ignores keepalive comments', async () => {
    const { stream, seen, stop } = await subscribe();

    stream.write(': keepalive\n\n');
    stream.write(recordFrame('AA3f1R', CHANGED));
    await vi.waitFor(() => expect(seen).toHaveLength(1));

    expect(seen).toHaveLength(1);
    stop();
  });

  // Ignoring is not disconnecting: a later minor adds frames, and a client
  // that errored on one would refuse a conformant server.
  test('ignores a frame name it does not know, and keeps reading', async () => {
    const { stream, seen, stop } = await subscribe();

    stream.write('id: AA3f1R\nevent: type\ndata: {"typeId":"com.example/note@2"}\n\n');
    stream.write(recordFrame('AA3f1S', CHANGED));
    await vi.waitFor(() => expect(seen).toHaveLength(1));

    expect(seen[0]!.recordId).toBe('1hk153x00001');
    stop();
  });

  test('reports a reset to onReset rather than swallowing the gap', async () => {
    const adapter = await openAdapter();
    const stream = feed();
    mockFetch.mockResolvedValueOnce(stream.response);
    const onReset = vi.fn();

    const subscription = adapter.subscribeChanges({ onReset }, () => {});
    stream.write(READY);
    const stop = await subscription;

    stream.write('event: reset\ndata: {"reason":"cursor_expired"}\n\n');
    await vi.waitFor(() => expect(onReset).toHaveBeenCalledOnce());
    stop();
  });
});

describe('reconnection', () => {
  test('comes back with the last frame id it saw', async () => {
    vi.useFakeTimers();
    const adapter = await openAdapter();
    const first = feed();
    mockFetch.mockResolvedValueOnce(first.response);

    const seen: RecordChange[] = [];
    const subscription = adapter.subscribeChanges({}, (c) => void seen.push(c));
    first.write(READY);
    const stop = await subscription;

    first.write(recordFrame('AA3f1R', CHANGED));
    await vi.waitFor(() => expect(seen).toHaveLength(1));

    const second = feed();
    mockFetch.mockResolvedValueOnce(second.response);
    first.end();

    await vi.advanceTimersByTimeAsync(60_000);
    await vi.waitFor(() => expect(mockFetch.mock.calls.length).toBe(3));

    expect(headersOf(2)['Last-Event-ID']).toBe('AA3f1R');
    stop();
  });

  // The head is where a refused cursor falls back to: replaying against a
  // position the server has already rejected would fail the same way twice.
  test('falls back to this connection’s head after a reset', async () => {
    vi.useFakeTimers();
    const adapter = await openAdapter();
    const first = feed();
    mockFetch.mockResolvedValueOnce(first.response);

    const subscription = adapter.subscribeChanges({ since: 'STALE1' }, () => {});
    first.write(READY);
    const stop = await subscription;

    first.write('event: reset\ndata: {"reason":"cursor_expired"}\n\n');
    const second = feed();
    mockFetch.mockResolvedValueOnce(second.response);
    first.end();

    await vi.advanceTimersByTimeAsync(60_000);
    await vi.waitFor(() => expect(mockFetch.mock.calls.length).toBe(3));

    expect(headersOf(1)['Last-Event-ID']).toBe('STALE1');
    expect(headersOf(2)['Last-Event-ID']).toBe('AA3f1Q');
    stop();
  });

  // A head outside the framable charset is no cursor at all: echoing one
  // into Last-Event-ID would have fetch refuse every reconnect, wedging a
  // feed that could have resumed from the present instead.
  test('discards a ready seq outside the framable charset', async () => {
    vi.useFakeTimers();
    const adapter = await openAdapter();
    const first = feed();
    mockFetch.mockResolvedValueOnce(first.response);

    const subscription = adapter.subscribeChanges({ since: 'STALE1' }, () => {});
    first.write('event: ready\ndata: {"seq":"AA\\r\\nX-Injected: 1"}\n\n');
    const stop = await subscription;

    first.write('event: reset\ndata: {"reason":"cursor_expired"}\n\n');
    const second = feed();
    mockFetch.mockResolvedValueOnce(second.response);
    first.end();

    await vi.advanceTimersByTimeAsync(60_000);
    await vi.waitFor(() => expect(mockFetch.mock.calls.length).toBe(3));

    expect(headersOf(2)['Last-Event-ID']).toBeUndefined();
    stop();
  });

  // A credential that cannot authenticate fails the reconnect the same way
  // it failed this one: retrying only spins. The subscriber hears it through
  // onError, and the loop stops rather than hammering with backoff forever.
  test('stops reconnecting after a fatal auth failure', async () => {
    vi.useFakeTimers();
    const adapter = await openAdapter();
    const first = feed();
    mockFetch.mockResolvedValueOnce(first.response);

    const onError = vi.fn();
    const subscription = adapter.subscribeChanges({ onError }, () => {});
    first.write(READY);
    const stop = await subscription;

    // The reconnect comes back 401. With no credential to renew, that is
    // terminal — APIAdapter has nothing to retry with.
    mockFetch.mockResolvedValueOnce(new Response('{}', { status: 401 }));
    first.end();

    await vi.advanceTimersByTimeAsync(60_000);
    await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());
    expect(onError.mock.calls[0]![0]).toBeInstanceOf(APIAdapterAuthError);

    // No further reconnect: the fetch count holds at discovery + first +
    // the 401 reconnect, even after more time passes.
    const calls = mockFetch.mock.calls.length;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(mockFetch.mock.calls.length).toBe(calls);
    stop();
  });

  // A request the server faulted is the same request on the next
  // connection, so the loop ends rather than spinning against a verdict
  // that will not change.
  test('stops reconnecting after a 4xx the reconnect would only repeat', async () => {
    vi.useFakeTimers();
    const adapter = await openAdapter();
    const first = feed();
    mockFetch.mockResolvedValueOnce(first.response);

    const onError = vi.fn();
    const subscription = adapter.subscribeChanges({ onError }, () => {});
    first.write(READY);
    const stop = await subscription;

    mockFetch.mockResolvedValueOnce(
      jsonResponse({ error: { code: 'bad_request', message: 'Invalid cursor' } }, 400),
    );
    first.end();

    await vi.advanceTimersByTimeAsync(60_000);
    await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());
    expect(onError.mock.calls[0]![0]).toBeInstanceOf(StackQueryError);

    // No further reconnect: the fetch count holds at discovery + first +
    // the refused reconnect, even after more time passes.
    const calls = mockFetch.mock.calls.length;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(mockFetch.mock.calls.length).toBe(calls);
    stop();
  });

  // 503 is a server shedding load, not a verdict on the request — being
  // reconnected against is the whole point of it.
  test('keeps reconnecting after a 503 the server may recover from', async () => {
    vi.useFakeTimers();
    const adapter = await openAdapter();
    const first = feed();
    mockFetch.mockResolvedValueOnce(first.response);

    const onError = vi.fn();
    const subscription = adapter.subscribeChanges({ onError }, () => {});
    first.write(READY);
    const stop = await subscription;

    mockFetch.mockResolvedValueOnce(
      jsonResponse({ error: { code: 'timeout', message: 'Shedding load' } }, 503),
    );
    const recovered = feed();
    mockFetch.mockResolvedValueOnce(recovered.response);
    first.end();

    await vi.advanceTimersByTimeAsync(60_000);
    await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());
    expect(onError.mock.calls[0]![0]).toBeInstanceOf(StackTimeoutError);

    // discovery + first + the 503 + the attempt that reaches the server
    // again: the subscription outlived the refusal.
    await vi.advanceTimersByTimeAsync(120_000);
    await vi.waitFor(() => expect(mockFetch.mock.calls.length).toBe(4));
    stop();
  });

  test('stops reconnecting once unsubscribed, and aborts the open stream', async () => {
    vi.useFakeTimers();
    const adapter = await openAdapter();
    const stream = feed();
    mockFetch.mockResolvedValueOnce(stream.response);

    const subscription = adapter.subscribeChanges({}, () => {});
    stream.write(READY);
    const stop = await subscription;

    const signal = requestInit(1).signal;
    expect(signal?.aborted).toBe(false);

    stop();
    stream.end();
    await vi.advanceTimersByTimeAsync(120_000);

    expect(signal?.aborted).toBe(true);
    expect(mockFetch.mock.calls.length).toBe(2);
  });
});
