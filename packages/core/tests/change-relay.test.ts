/**
 * Changes that originate elsewhere. `Stack` emits what is written through
 * it; an adapter with a feed reports what was written somewhere else, and
 * these pin how the two reach one subscriber without either deciding for
 * the other. See docs/spec/events.md § Where events come from.
 */
import { describe, test, expect, beforeEach, vi } from 'vitest';
import { Stack, StackRelayScopeError } from '../src/stack.js';
import { MemoryAdapter } from '../src/testing.js';
import type { RecordChange, SubscribeChangesOptions } from '../src/types.js';

const NOTE = 'com.example.test/note@1';
const OWNER = 'owner-123';
const REMOTE_EDITOR = 'did:key:zRemote';

/**
 * An adapter that also relays, standing in for the wire one. Holds the
 * subscription it was given so a test can push a frame through it and
 * assert what a subscriber saw.
 */
class RelayingMemoryAdapter extends MemoryAdapter {
  readonly relays: {
    opts: SubscribeChangesOptions;
    push: (change: RecordChange) => void;
    stopped: boolean;
  }[] = [];

  /** Set to reject the next relay, standing in for a feed that will not open. */
  refuseWith: Error | undefined;

  async subscribeChanges(
    opts: SubscribeChangesOptions,
    handler: (change: RecordChange) => void,
  ): Promise<() => void> {
    if (this.refuseWith) throw this.refuseWith;
    const relay = { opts, push: handler, stopped: false };
    this.relays.push(relay);
    return () => {
      relay.stopped = true;
    };
  }
}

const remoteChange = (overrides: Partial<RecordChange> = {}): RecordChange => ({
  kind: 'changed',
  op: 'update',
  recordId: '1hk153x00001',
  typeId: NOTE,
  version: 4,
  updatedAt: new Date('2024-01-02T00:00:00.000Z'),
  actor: { entityId: REMOTE_EDITOR },
  seq: 'AA3f1R',
  ...overrides,
});

let adapter: RelayingMemoryAdapter;
let stack: Stack;

beforeEach(async () => {
  adapter = new RelayingMemoryAdapter({ ownerEntityId: OWNER, timezone: 'UTC' });
  stack = await Stack.create(adapter);
  await stack.defineType(NOTE, 'Note', { text: { kind: 'text', required: true } });
});

describe('a stack whose adapter relays', () => {
  test('opens one relay per subscription, carrying that subscription’s filter', async () => {
    await stack.subscribe(() => {}, { filter: { typeId: NOTE }, includeRecords: true });
    await stack.subscribe(() => {}, { filter: { entityId: REMOTE_EDITOR } });

    expect(adapter.relays).toHaveLength(2);
    expect(adapter.relays[0]!.opts.filter).toEqual({ typeId: NOTE });
    expect(adapter.relays[0]!.opts.includeRecords).toBe(true);
    // The author is not in the envelope, so only the emitter holding the
    // record can answer this filter — which is why it travels.
    expect(adapter.relays[1]!.opts.filter).toEqual({ entityId: REMOTE_EDITOR });
  });

  test('delivers a relayed frame to the subscriber that opened it', async () => {
    const seen: RecordChange[] = [];
    await stack.subscribe((c) => void seen.push(c));

    adapter.relays[0]!.push(remoteChange());

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ recordId: '1hk153x00001', version: 4, seq: 'AA3f1R' });
  });

  // The far end applied the filter against the record it held. Re-deriving
  // that here would need fields the envelope deliberately omits, and on a
  // purge there is nothing left to derive from at all.
  test('delivers a relayed frame without re-applying the filter locally', async () => {
    const seen: RecordChange[] = [];
    await stack.subscribe((c) => void seen.push(c), { filter: { typeId: NOTE } });

    adapter.relays[0]!.push(remoteChange({ typeId: 'com.example.test/other@1' }));

    expect(seen).toHaveLength(1);
  });

  test('delivers a relayed purge, which carries no record to check', async () => {
    const seen: RecordChange[] = [];
    await stack.subscribe((c) => void seen.push(c), { filter: { typeId: NOTE } });

    adapter.relays[0]!.push(
      remoteChange({ kind: 'purged', op: 'hard-delete', actor: { entityId: OWNER } }),
    );

    expect(seen[0]).toMatchObject({ kind: 'purged', op: 'hard-delete' });
    expect(seen[0]).not.toHaveProperty('record');
  });

  test('routes a throwing handler’s error to onError, as a local event does', async () => {
    const onError = vi.fn();
    await stack.subscribe(
      () => {
        throw new Error('subscriber blew up');
      },
      { onError },
    );

    adapter.relays[0]!.push(remoteChange());

    expect(onError).toHaveBeenCalledOnce();
    expect((onError.mock.calls[0]![0] as Error).message).toBe('subscriber blew up');
  });

  test('passes onReset through, so a gap the adapter could not close surfaces', async () => {
    const onReset = vi.fn();
    await stack.subscribe(() => {}, { onReset });

    adapter.relays[0]!.opts.onReset?.();

    expect(onReset).toHaveBeenCalledOnce();
  });

  test('still emits local writes, so a subscriber sees its own', async () => {
    const seen: RecordChange[] = [];
    await stack.subscribe((c) => void seen.push(c), { filter: { typeId: NOTE } });

    await stack.create(NOTE, { text: 'written here' });

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ kind: 'created', op: 'create' });
  });

  test('stops the relay and the local stream on unsubscribe', async () => {
    const seen: RecordChange[] = [];
    const unsubscribe = await stack.subscribe((c) => void seen.push(c));

    unsubscribe();
    adapter.relays[0]!.push(remoteChange());
    await stack.create(NOTE, { text: 'after' });

    expect(adapter.relays[0]!.stopped).toBe(true);
    expect(seen).toHaveLength(0);
  });

  // A subscribe() that throws must leave nothing registered: the caller
  // holds no unsubscribe function to clean up with.
  test('registers nothing locally when the relay refuses to open', async () => {
    adapter.refuseWith = new Error('no feed here');
    const seen: RecordChange[] = [];

    await expect(stack.subscribe((c) => void seen.push(c))).rejects.toThrow('no feed here');
    await stack.create(NOTE, { text: 'after the failure' });

    expect(seen).toHaveLength(0);
  });
});

describe('a scoped view of a stack that relays', () => {
  test('refuses to subscribe rather than narrow a feed it cannot re-scope', async () => {
    const scoped = stack.asEntity(REMOTE_EDITOR);
    await expect(scoped.subscribe(() => {})).rejects.toBeInstanceOf(StackRelayScopeError);
  });

  test('subscribes normally when the adapter relays nothing', async () => {
    const local = await Stack.create(new MemoryAdapter({ ownerEntityId: OWNER, timezone: 'UTC' }));
    await local.defineType(NOTE, 'Note', { text: { kind: 'text', required: true } });

    const scoped = local.asEntity(OWNER);
    const unsubscribe = await scoped.subscribe(() => {});

    expect(unsubscribe).toBeTypeOf('function');
    await local.close();
  });
});
