/**
 * Search parameters
 * -------------------------------------------------------
 * Requests' URL parameters, and the two filter encodings that need more
 * than a name and a value: `GET /records` for a server reaching no
 * content, and `GET /changes`. See docs/spec/wire-format.md § Records.
 */

import type { StackQuery, ChangeFilter, RecordFilter, SubscribeOptions } from '@haverstack/core';

/** A path with its search params attached, or the bare path when there are none. */
export const withParams = (path: string, params: URLSearchParams): string => {
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
};

/**
 * A filter field naming one value or many travels as repeats of a single
 * parameter, so the server reads one shape either way.
 */
const appendEach = (p: URLSearchParams, name: string, value: string | string[]): void => {
  for (const v of Array.isArray(value) ? value : [value]) p.append(name, v);
};

/**
 * `null` names the root, which has to be spelled rather than omitted: an
 * absent parameter asks for records at any depth.
 */
const setParentId = (p: URLSearchParams, parentId: string | null): void => {
  p.set('parentId', parentId === null ? 'null' : parentId);
};

/** The author filter, spelled the same on `GET /records` and `GET /changes`. */
const appendCreatedBy = (p: URLSearchParams, createdBy: RecordFilter['createdBy']): void => {
  if (createdBy?.subjectId !== undefined) appendEach(p, 'createdBySubject', createdBy.subjectId);
  if (createdBy?.principalId !== undefined)
    appendEach(p, 'createdByPrincipal', createdBy.principalId);
};

export const buildQueryParams = (query: StackQuery): URLSearchParams => {
  const p = new URLSearchParams();
  const f = query.filter ?? {};

  if (f.typeId !== undefined) appendEach(p, 'typeId', f.typeId);
  if (f.parentId !== undefined) setParentId(p, f.parentId);
  if (f.appId !== undefined) appendEach(p, 'appId', f.appId);
  appendCreatedBy(p, f.createdBy);
  if (f.createdAt?.before) p.set('createdBefore', f.createdAt.before.toISOString());
  if (f.createdAt?.after) p.set('createdAfter', f.createdAt.after.toISOString());
  if (f.updatedAt?.before) p.set('updatedBefore', f.updatedAt.before.toISOString());
  if (f.updatedAt?.after) p.set('updatedAfter', f.updatedAt.after.toISOString());
  if (f.tags) for (const tag of f.tags) p.append('tag', tag);
  if (f.attachment?.label !== undefined) p.set('attachmentLabel', f.attachment.label);
  if (f.attachment?.fileId !== undefined) p.set('attachmentFileId', f.attachment.fileId);
  if (f.referencesFileId) p.set('referencesFileId', f.referencesFileId);
  if (f.relatedTo) {
    // The target kind is implied by which qualifier appears, and the type
    // guarantees at least one of these branches sets something — so the
    // filter can never encode to nothing and silently widen the query.
    // The server rejects a mix of kinds.
    const t = f.relatedTo.target;
    if (t?.kind === 'record') {
      p.set('relatedTo', t.recordId);
      if (t.stackUrl !== undefined) p.set('relatedToStack', t.stackUrl);
    } else if (t?.kind === 'entity') {
      p.set('relatedToEntity', t.entityId);
    } else if (t?.kind === 'external') {
      p.set('relatedToNs', t.ns);
      if (t.id !== undefined) p.set('relatedToId', t.id);
    }
    if (f.relatedTo.label !== undefined) p.set('relatedToLabel', f.relatedTo.label);
  }
  if (f.search) p.set('search', f.search);
  if (f.includeDeleted) p.set('includeDeleted', 'true');
  if (f.includeUnlisted) p.set('includeUnlisted', 'true');
  // Which parameter carries the name is what says whether it names a
  // native column or a content field — the same "kind implied by the
  // parameter" shape the relationship filter uses above.
  if (query.sort?.contentField) p.set('sortContent', query.sort.contentField);
  if (query.sort?.field) p.set('sort', query.sort.field);
  if (query.sort?.direction) p.set('direction', query.sort.direction);
  if (query.limit) p.set('limit', String(query.limit));
  if (query.cursor) p.set('cursor', query.cursor);

  return p;
};

export const buildChangeParams = (opts: SubscribeOptions): URLSearchParams => {
  const p = new URLSearchParams();
  const f: ChangeFilter = opts.filter ?? {};

  if (f.typeId !== undefined) appendEach(p, 'typeId', f.typeId);
  if (f.baseId !== undefined) appendEach(p, 'baseId', f.baseId);
  if (f.parentId !== undefined) setParentId(p, f.parentId);
  appendCreatedBy(p, f.createdBy);
  if (f.kinds !== undefined) for (const kind of f.kinds) p.append('kind', kind);
  if (opts.includeRecords) p.set('include', 'record');
  if (opts.includeUnlisted) p.set('includeUnlisted', 'true');

  return p;
};
