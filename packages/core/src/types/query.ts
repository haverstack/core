/**
 * Query filters, sorting, and the page a query returns.
 */

import type { RecordId, TypeId, BaseId, FileId, AppId, EntityId } from './ids.js';
import type { StackRecord } from './records.js';

/**
 * A target pattern in `RecordFilter.relatedTo` — the association shape with
 * the parts a query may leave open: an `external` target without `id`
 * matches its whole namespace.
 */
export type RelationshipTargetPattern =
  | { kind: 'record'; recordId: RecordId; stackUrl?: string }
  | { kind: 'entity'; entityId: EntityId }
  | { kind: 'external'; ns: string; id?: string };

/**
 * A relationship query names a label, a target, or both — never neither.
 * "Carries any relationship at all" is deliberately not expressible, in
 * line with `tags` and `attachment`, which likewise have no match-any
 * form. See docs/spec/data-model.md § Filter.
 */
export type RelatedToFilter =
  | { label: string; target?: RelationshipTargetPattern }
  | { label?: string; target: RelationshipTargetPattern };

/**
 * An attachment query names a label, a file, or both — never neither —
 * and both halves together match one association. See
 * docs/spec/data-model.md § Filter.
 */
export type AttachmentFilter =
  | { label: string; fileId?: FileId }
  | { label?: string; fileId: FileId };

export type DateRange = {
  before?: Date;
  after?: Date;
};

export type RecordFilter = {
  // Native fields
  typeId?: TypeId | TypeId[];
  /**
   * Match every version of a type family, resolved against registered
   * Types rather than parsed from typeId strings. Intersects with `typeId`
   * when both are given. A value carrying an `@version` suffix is refused
   * with StackValidationError.
   */
  baseId?: BaseId | BaseId[];
  parentId?: RecordId | null; // null = root records only
  appId?: AppId | AppId[];
  /** Matches the record's author — never the latest actor, which isn't filterable. */
  createdBy?: {
    subjectId?: EntityId | EntityId[];
    principalId?: EntityId | EntityId[];
  };
  createdAt?: DateRange;
  updatedAt?: DateRange;

  // Association filters
  tags?: string[]; // Records that have ALL of these tags
  /** Records carrying a matching attachment association. See docs/spec/data-model.md § Filter. */
  attachment?: AttachmentFilter;
  /**
   * Records carrying a matching relationship association. Either half may
   * be given alone and each is a pattern: a bare `label` matches every
   * target under it, and an `external` target with no `id` matches the
   * whole namespace. An absent `stackUrl` on a `record` target matches
   * only local targets. See docs/spec/data-model.md § Filter.
   */
  relatedTo?: RelatedToFilter;
  /**
   * Records that reference this file, through an attachment association
   * or a top-level `file-ref` content field — the question GC and
   * `deleteAttachment()` ask. See docs/spec/attachments.md § Deleting attachments.
   */
  referencesFileId?: FileId;

  /**
   * Exact match on content fields, keyed by a dot-separated path
   * (`'emails.value'`); an array along the path matches element-wise. A
   * multi-segment key needs `filter.content: 'path'`. POST /records/query
   * only. See docs/spec/data-model.md § Filter.
   */
  content?: Record<string, unknown>;

  /**
   * Paths that must hold a non-null value — the question `content` cannot
   * ask. Element-wise like `content`. Needs `filter.contentPresent`.
   * POST /records/query only. See docs/spec/data-model.md § Filter.
   */
  contentPresent?: string[];

  // Full-text search (capability varies by adapter)
  search?: string;

  // Soft-deleted records are excluded by default
  includeDeleted?: boolean;

  /**
   * Unlisted records are excluded by default, like soft-deleted ones.
   * Owner-only under `ScopedStack` — enumeration standing rests on nothing
   * but ownership, so a grant or delegation never carries it. See
   * docs/spec/unlisted.md.
   */
  includeUnlisted?: boolean;
};

/**
 * The Record columns every adapter stores natively, and can order by. The
 * array is the source of truth, so the runtime checks that narrow a wire
 * value or a cursor to this set can't drift from NativeSortField.
 */
export const NATIVE_SORT_FIELDS = ['createdAt', 'updatedAt', 'version'] as const;

export type NativeSortField = (typeof NATIVE_SORT_FIELDS)[number];

/**
 * Order by a native column or a top-level content field — two members, so
 * a content field named `version` stays distinct from the native column.
 * `direction` defaults to `asc`; a query with no sort is `createdAt`,
 * newest first. See docs/spec/data-model.md § Sorting by a content field.
 */
export type QuerySort =
  | { field: NativeSortField; contentField?: never; direction?: 'asc' | 'desc' }
  | { field?: never; contentField: string; direction?: 'asc' | 'desc' };

export type StackQuery = {
  filter?: RecordFilter;
  sort?: QuerySort;
  limit?: number;
  cursor?: string; // Opaque cursor for page-based pagination
  /**
   * "stored" (the default) returns records as stored; "latest" applies the
   * migration chain in memory, never written back. Throws
   * StackMigrationError if a matched record has no path to the latest.
   */
  presentAt?: 'stored' | 'latest';
};

/**
 * A page of results and where the next one resumes. There is no count of
 * the whole match: see docs/spec/data-model.md § Sorting and pagination.
 */
export type QueryResult = {
  records: StackRecord[];
  cursor: string | null;
};
