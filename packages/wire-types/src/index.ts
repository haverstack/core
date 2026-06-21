import type {
  StackRecord,
  StackType,
  RecordVersion,
  Association,
  Permission,
} from '@haverstack/core';

export type WireRecord = {
  id: string;
  typeId: string;
  createdAt: string;
  updatedAt: string;
  content: Record<string, unknown>;
  version: number;
  parentId?: string;
  entityId?: string;
  appId?: string;
  deletedAt?: string;
  permissions?: Permission[];
  associations?: Association[];
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

export type WireVersion = {
  version: number;
  content: Record<string, unknown>;
  updatedAt: string;
  entityId?: string;
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
  if (r.entityId !== undefined) w.entityId = r.entityId;
  if (r.appId !== undefined) w.appId = r.appId;
  if (r.deletedAt !== undefined) w.deletedAt = r.deletedAt.toISOString();
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
    content: v.content,
    updatedAt: v.updatedAt.toISOString(),
  };
  if (v.entityId !== undefined) w.entityId = v.entityId;
  return w;
}

/** Parse an ISO date string from a wire body, returns undefined if absent or invalid. */
export function parseDate(val: unknown): Date | undefined {
  if (typeof val !== 'string') return undefined;
  const d = new Date(val);
  return isNaN(d.getTime()) ? undefined : d;
}
