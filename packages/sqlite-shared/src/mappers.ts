/**
 * Row <-> domain object mappers shared by every SQLite-backed record
 * adapter. Column names and JSON-encoding choices are the storage
 * contract; keeping one copy means the adapters can't drift on them.
 */

import type {
  StackRecord,
  StackType,
  RecordVersion,
  Association,
  RelationshipTarget,
} from '@haverstack/core';

export const toMs = (d: Date): number => d.getTime();
export const fromMs = (ms: number): Date => new Date(ms);

export const rowToRecord = (
  row: Record<string, unknown>,
  associations: Association[],
): StackRecord => {
  const record: StackRecord = {
    id: row.id as string,
    typeId: row.type_id as string,
    createdAt: fromMs(row.created_at as number),
    updatedAt: fromMs(row.updated_at as number),
    content: JSON.parse(row.content as string),
    version: row.version as number,
  };
  if (row.parent_id) record.parentId = row.parent_id as string;
  if (row.entity_id) record.entityId = row.entity_id as string;
  if (row.app_id) record.appId = row.app_id as string;
  if (row.principal_id) record.principalId = row.principal_id as string;
  if (row.updated_by) record.updatedBy = row.updated_by as string;
  if (row.updated_via) record.updatedVia = row.updated_via as string;
  if (row.deleted_at) record.deletedAt = fromMs(row.deleted_at as number);
  if (row.permissions) record.permissions = JSON.parse(row.permissions as string);
  if (associations.length) record.associations = associations;
  return record;
};

export const rowToAssociation = (row: Record<string, unknown>): Association => {
  if (row.kind === 'tag') {
    return { kind: 'tag', label: row.label as string };
  }
  if (row.kind === 'attachment') {
    return {
      kind: 'attachment',
      label: row.label as string,
      fileId: row.file_id as string,
    };
  }
  // relationship
  return {
    kind: 'relationship',
    label: row.label as string,
    target: rowToTarget(row),
  };
};

/**
 * The five columns that identify an association, in the order every
 * INSERT and DELETE below binds them. One helper because the two must
 * agree exactly — a dissociate that bound them differently would delete
 * nothing and report success.
 */
export const associationKeyColumns = (a: Association): [string, string, string, string, string] => {
  if (a.kind === 'attachment') return [a.fileId, '', '', '', ''];
  if (a.kind !== 'relationship') return ['', '', '', '', ''];
  const t = a.target;
  if (t.scope === 'entity') return ['', 'entity', t.entityId, '', ''];
  if (t.scope === 'external') return ['', 'external', t.id, t.ns, ''];
  return ['', 'record', t.recordId, '', t.stackUrl ?? ''];
};

const rowToTarget = (row: Record<string, unknown>): RelationshipTarget => {
  const id = row.related_id as string;
  if (row.related_scope === 'entity') return { scope: 'entity', entityId: id };
  if (row.related_scope === 'external') {
    return { scope: 'external', ns: row.related_ns as string, id };
  }
  const stackUrl = row.related_stack as string;
  return { scope: 'record', recordId: id, ...(stackUrl && { stackUrl }) };
};

export const rowToType = (row: Record<string, unknown>): StackType => {
  const t: StackType = {
    id: row.id as string,
    baseId: row.base_id as string,
    version: row.version as number,
    name: row.name as string,
    schema: JSON.parse(row.schema as string),
    schemaHash: row.schema_hash as string,
    createdAt: fromMs(row.created_at as number),
  };
  if (row.migrates_from) t.migratesFrom = row.migrates_from as string;
  return t;
};

export const rowToVersion = (row: Record<string, unknown>): RecordVersion => {
  const v: RecordVersion = {
    version: row.version as number,
    typeId: row.type_id as string,
    content: JSON.parse(row.content as string),
    updatedAt: fromMs(row.updated_at as number),
  };
  if (row.entity_id) v.entityId = row.entity_id as string;
  if (row.updated_by) v.updatedBy = row.updated_by as string;
  if (row.updated_via) v.updatedVia = row.updated_via as string;
  if (row.associations) v.associations = JSON.parse(row.associations as string);
  if (row.permissions) v.permissions = JSON.parse(row.permissions as string);
  return v;
};
