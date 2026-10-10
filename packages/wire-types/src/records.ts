/**
 * Records, types, versions and actors
 * -------------------------------------------------------
 * The stored shapes as a response carries them — dates as ISO strings,
 * optional fields absent rather than undefined — and the envelopes that
 * page them. See docs/spec/wire-format.md.
 */

import type {
  Actor,
  ChangeActor,
  RecordVersion,
  StackRecord,
  StackType,
  AuthorityAssociation,
  DataAssociation,
} from '@haverstack/core';

/**
 * An Actor on the wire — the same two fields, spelled the same way, so an
 * alias rather than a second definition to drift.
 */
export type WireActor = Actor;

/** Copied field by field, so a response never aliases a stored record's object. */
function serializeActor(a: Actor): WireActor {
  const w: WireActor = { subjectId: a.subjectId };
  if (a.principalId !== undefined) w.principalId = a.principalId;
  return w;
}

/** Who performed a change. Never who authored the record. Same shape as core's. */
export type WireChangeActor = ChangeActor;

/** Shared by a change frame and a journal entry — one actor encoding, not two. */
export function serializeChangeActor(actor: ChangeActor): WireChangeActor {
  const w: WireChangeActor = serializeActor(actor);
  if (actor.appId !== undefined) w.appId = actor.appId;
  return w;
}

export type WireRecord = {
  id: string;
  typeId: string;
  createdAt: string;
  updatedAt: string;
  content: Record<string, unknown>;
  version: number;
  parentId?: string;
  appId?: string;
  createdBy?: WireActor;
  updatedBy?: WireActor;
  deletedAt?: string;
  unlistedAt?: string;
  permissions?: AuthorityAssociation[];
  associations?: DataAssociation[];
};

/**
 * The response envelope of `GET /records` and `POST /records/query`.
 * `cursor` is the only end-of-results signal — a page may be empty while
 * it is non-null — and there is no count of the whole match. See
 * docs/spec/wire-format.md § Response envelope.
 */
export type WireQueryResponse = {
  records: WireRecord[];
  cursor: string | null;
};

export type WireType = {
  id: string;
  baseId: string;
  version: number;
  name: string;
  schema: Record<string, unknown>;
  schemaHash: string;
  migratesFrom?: string;
  createdAt: string;
};

/**
 * No `associations`, `permissions`, `parentId` or `unlistedAt`: none of the
 * four bumps `version`, so no version ever snapshots them. See
 * docs/spec/wire-format.md § Versions.
 */
export type WireVersion = {
  version: number;
  typeId: string;
  content: Record<string, unknown>;
  updatedAt: string;
  createdBy?: WireActor;
  updatedBy?: WireActor;
};

export function serializeRecord(r: StackRecord): WireRecord {
  const w: WireRecord = {
    id: r.id,
    typeId: r.typeId,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    content: r.content,
    version: r.version,
  };
  if (r.parentId !== undefined) w.parentId = r.parentId;
  if (r.appId !== undefined) w.appId = r.appId;
  if (r.createdBy !== undefined) w.createdBy = serializeActor(r.createdBy);
  if (r.updatedBy !== undefined) w.updatedBy = serializeActor(r.updatedBy);
  if (r.deletedAt !== undefined) w.deletedAt = r.deletedAt.toISOString();
  if (r.unlistedAt !== undefined) w.unlistedAt = r.unlistedAt.toISOString();
  if (r.permissions !== undefined) w.permissions = r.permissions;
  if (r.associations !== undefined) w.associations = r.associations;
  return w;
}

export function serializeType(t: StackType): WireType {
  const w: WireType = {
    id: t.id,
    baseId: t.baseId,
    version: t.version,
    name: t.name,
    schema: t.schema as Record<string, unknown>,
    schemaHash: t.schemaHash,
    createdAt: t.createdAt.toISOString(),
  };
  if (t.migratesFrom !== undefined) w.migratesFrom = t.migratesFrom;
  return w;
}

export function serializeVersion(v: RecordVersion): WireVersion {
  const w: WireVersion = {
    version: v.version,
    typeId: v.typeId,
    content: v.content,
    updatedAt: v.updatedAt.toISOString(),
  };
  if (v.createdBy !== undefined) w.createdBy = serializeActor(v.createdBy);
  if (v.updatedBy !== undefined) w.updatedBy = serializeActor(v.updatedBy);
  return w;
}

/**
 * The response envelope of `GET /records/:id/versions`.
 *
 * `cursor` is the only end-of-history signal, as on the journal: a server
 * may cap a page below the `limit` asked for. It carries the `version` to
 * send as the next `beforeVersion`, and is null once nothing follows.
 */
export type WireVersionsResponse = {
  versions: WireVersion[];
  cursor: number | null;
};
