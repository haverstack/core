/**
 * Change feed
 * -------------------------------------------------------
 * How a server advertises the feed, and the frames it streams.
 * See docs/spec/change-feed.md.
 */

import type {
  ChangeActor,
  ChangeKind,
  ChangeOp,
  DataAssociation,
  RecordChange,
} from '@haverstack/core';
import { serializeActor, serializeRecord, type WireRecord } from './records.js';

/**
 * The change feed a server offers, absent when it offers none. An object
 * rather than a boolean for the same reason `auth` is one: this surface
 * grows entries. See docs/spec/change-feed.md.
 */
export type DiscoveryChanges = {
  transports: ChangeTransport[];
  /**
   * Whether a resume cursor is honored. `false` is conformant and means
   * every reconnect is answered with a `reset` frame.
   */
  resume: boolean;
  /** Whether `?include=record` is honored. Never honored for a purge. */
  records: boolean;
};

/** Server→client streaming over `fetch`. The only transport in this version. */
export const CHANGE_TRANSPORT_SSE = 'sse';

export type ChangeTransport = typeof CHANGE_TRANSPORT_SSE;

/**
 * Whether a server offers a change feed this client can consume. A client
 * checks this and fails locally rather than learning it as a 404 partway
 * through a connection — the same reason `auth.methods` exists.
 */
export function supportsChangeFeed(discovery: { changes?: DiscoveryChanges }): boolean {
  return discovery.changes?.transports?.includes(CHANGE_TRANSPORT_SSE) ?? false;
}

/**
 * One change, as a `record` frame carries it. The envelope describes the
 * change and nothing else: the record's own provenance rides `record`,
 * where a consumer that wants it asks for it. See docs/spec/events.md
 * § Attribution.
 */
export type WireRecordChange = {
  kind: ChangeKind;
  /** Every aspect this version moved; never empty. See RecordChange.ops. */
  ops: ChangeOp[];
  recordId: string;
  typeId: string;
  version: number;
  updatedAt: string;
  parentId?: string;
  actor?: WireChangeActor;
  /** Present when `ops` includes `associate`. See RecordChange.associationsAdded. */
  associationsAdded?: DataAssociation[];
  /** Present when `ops` includes `dissociate`. See RecordChange.associationsRemoved. */
  associationsRemoved?: DataAssociation[];
  record?: WireRecord;
  cursor?: string;
};

/** Who performed a change. Never who authored the record. Same shape as core's. */
export type WireChangeActor = ChangeActor;

/** Shared by a change frame and a journal entry — one actor encoding, not two. */
export function serializeChangeActor(actor: ChangeActor): WireChangeActor {
  const w: WireChangeActor = serializeActor(actor);
  if (actor.appId !== undefined) w.appId = actor.appId;
  return w;
}

/**
 * A change as a server frames it. A purge carries neither the record nor
 * its parent, whatever was asked for: purge is the erasure primitive, and
 * the rule lives here because a server still holds the purged record at
 * emission. See docs/spec/events.md § Purged records carry nothing.
 */
export function serializeChange(c: RecordChange): WireRecordChange {
  const w: WireRecordChange = {
    kind: c.kind,
    // Copied, not aliased: a frame is serialized once and delivered to
    // every subscriber, and the array it came from belongs to the emission.
    ops: [...c.ops],
    recordId: c.recordId,
    typeId: c.typeId,
    version: c.version,
    updatedAt: c.updatedAt.toISOString(),
  };
  if (c.actor !== undefined) w.actor = serializeChangeActor(c.actor);
  if (c.cursor !== undefined) w.cursor = c.cursor;
  if (c.kind === 'purged') return w;
  if (c.parentId !== undefined) w.parentId = c.parentId;
  if (c.associationsAdded !== undefined) w.associationsAdded = c.associationsAdded;
  if (c.associationsRemoved !== undefined) w.associationsRemoved = c.associationsRemoved;
  if (c.record !== undefined) w.record = serializeRecord(c.record);
  return w;
}

/**
 * Frame names. Every frame carries one, and a client MUST ignore a name it
 * does not recognize — which is what makes a new frame an additive, minor
 * change rather than a break. See docs/spec/change-feed.md.
 */
export const CHANGE_FRAME_READY = 'ready';
export const CHANGE_FRAME_RECORD = 'record';
export const CHANGE_FRAME_RESET = 'reset';

/**
 * Sent first on every connection, before any change. It is what makes
 * subscribe-then-query gap-free: everything after it is in the stream.
 */
export type WireReadyFrame = {
  /** The head cursor. Absent from a server that mints none (`resume: false`). */
  cursor?: string;
};

/**
 * Why a cursor could not be honored. Informational — a client's repair is
 * the same for all three, and it is reconciling by query.
 */
export type ChangeResetReason = 'cursor_expired' | 'not_supported' | 'overflow';

/** Your cursor cannot be honored; resynchronize by query. */
export type WireResetFrame = {
  reason: ChangeResetReason;
};

/**
 * A cursor travels in an SSE `id:` field, so a value spanning a line would
 * truncate the frame carrying it. Same charset and same reason as the auth
 * nonce — see docs/spec/wire-format.md § The handshake.
 */
const CURSOR_FORMAT = /^[A-Za-z0-9_-]+$/;

/** Whether a cursor is framable: unreserved base64url characters only. */
export function isValidCursor(cursor: string): boolean {
  return CURSOR_FORMAT.test(cursor);
}
