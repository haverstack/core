/**
 * The engine-independent half of a SQLite-backed StackRecordAdapter: the
 * capability declaration and the delegation of all twenty-three
 * StackRecordAdapter methods onto SharedSqlRecordLogic. Every method here
 * is a forward with no engine-specific content, so an adapter that owns a
 * SqlExecutor already knows how to answer all of them.
 *
 * What a concrete adapter is left to supply is exactly what differs
 * between bindings: constructing the database handle, applying the
 * schema, and its own lifecycle (flush/close) — hence those two being the
 * only abstract members.
 *
 * Lives in record.js's barrel rather than index.js's, so an adapter that
 * imports it never pulls in token-logic.ts's `node:crypto` — see the note
 * at the top of record.ts.
 */

import type {
  JournalQuery,
  VersionsQuery,
  RecordJournalEntry,
  StackType,
  TypeId,
  FileId,
  RecordVersion,
  StackRecord,
  StackQuery,
  QueryResult,
  AssociationEdit,
  AuthorityAssociation,
  DataAssociation,
  StackCapabilities,
} from '@haverstack/core';
import type {
  StackRecordAdapter,
  AspectWriteOptions,
  ElementWriteOptions,
  JournalOptions,
  MutateOptions,
  ReadReach,
} from '@haverstack/core/adapter';
import type { SqlExecutor } from './executor.js';
import type { StackConfig } from './config.js';
import { SharedSqlRecordLogic } from './record-logic.js';

/**
 * What every engine running SharedSqlRecordLogic's query builder supports.
 * It describes the shared SQL, not the binding, so it is the same for each
 * of them — an engine whose SQLite build lacked FTS5 would override
 * `filter.search` rather than restate the whole declaration.
 */
export const SQLITE_RECORD_CAPABILITIES: StackCapabilities = {
  filter: {
    content: 'path',
    contentPresent: true,
    // Inside SQLite's limits on expression depth and compound selects; see
    // docs/spec/adapters.md § Adapter capabilities.
    contentByType: 64,
    search: true,
  },
  sort: {
    fields: ['createdAt', 'updatedAt', 'version'],
    contentField: true,
    contentFieldByType: 64,
  },
  limits: {
    attachmentBytes: null,
    contentBytes: null,
  },
};

export abstract class SharedSqlRecordAdapter implements StackRecordAdapter {
  readonly capabilities: StackCapabilities = SQLITE_RECORD_CAPABILITIES;

  readonly ownerEntityId: string;
  readonly timezone: string | undefined;

  private readonly record: SharedSqlRecordLogic;

  protected constructor(exec: SqlExecutor, config: StackConfig) {
    this.record = new SharedSqlRecordLogic({ exec });
    this.ownerEntityId = config.entityId;
    this.timezone = config.timezone;
  }

  // -------------------------------------------------------
  // Records
  // -------------------------------------------------------

  createRecord(record: StackRecord, opts?: JournalOptions): Promise<StackRecord> {
    return this.record.createRecord(record, opts);
  }

  getRecord(id: string): Promise<StackRecord | null> {
    return this.record.getRecord(id);
  }

  patchContent(
    id: string,
    patch: Record<string, unknown | null>,
    opts?: MutateOptions,
  ): Promise<StackRecord> {
    return this.record.patchContent(id, patch, opts);
  }

  setParent(id: string, parentId: string | null, opts?: AspectWriteOptions): Promise<StackRecord> {
    return this.record.setParent(id, parentId, opts);
  }

  setUnlisted(id: string, unlisted: boolean, opts?: AspectWriteOptions): Promise<StackRecord> {
    return this.record.setUnlisted(id, unlisted, opts);
  }

  deleteRecord(
    id: string,
    opts?: { purge?: boolean } & MutateOptions,
  ): Promise<StackRecord | null> {
    return this.record.deleteRecord(id, opts);
  }

  undeleteRecord(id: string, opts?: MutateOptions): Promise<StackRecord> {
    return this.record.undeleteRecord(id, opts);
  }

  restoreVersion(id: string, version: number, opts?: MutateOptions): Promise<StackRecord> {
    return this.record.restoreVersion(id, version, opts);
  }

  commitMigration(
    id: string,
    toTypeId: TypeId,
    content: Record<string, unknown>,
    opts?: MutateOptions,
  ): Promise<StackRecord> {
    return this.record.commitMigration(id, toTypeId, content, opts);
  }

  queryRecords(query: StackQuery): Promise<QueryResult> {
    return this.record.queryRecords(query);
  }

  queryReadable(query: StackQuery, reach: ReadReach): Promise<QueryResult> {
    return this.record.queryRecords(query, reach);
  }

  deleteUnreferencedAttachmentRecords(
    fileId: FileId,
    metadataTypeIds: TypeId[],
  ): Promise<StackRecord[]> {
    return this.record.deleteUnreferencedAttachmentRecords(fileId, metadataTypeIds);
  }

  // -------------------------------------------------------
  // Versions
  // -------------------------------------------------------

  getVersions(id: string, query?: VersionsQuery): Promise<RecordVersion[]> {
    return this.record.getVersions(id, query);
  }

  getVersion(id: string, version: number): Promise<RecordVersion | null> {
    return this.record.getVersion(id, version);
  }

  saveVersion(id: string, version: RecordVersion): Promise<void> {
    return this.record.saveVersion(id, version);
  }

  // -------------------------------------------------------
  // Change journal
  // -------------------------------------------------------

  getJournal(id: string, query?: JournalQuery): Promise<RecordJournalEntry[]> {
    return this.record.getJournal(id, query);
  }

  // -------------------------------------------------------
  // Types
  // -------------------------------------------------------

  saveType(type: StackType): Promise<void> {
    return this.record.saveType(type);
  }

  getType(id: TypeId): Promise<StackType | null> {
    return this.record.getType(id);
  }

  listTypes(): Promise<StackType[]> {
    return this.record.listTypes();
  }

  // -------------------------------------------------------
  // Associations and permissions
  // -------------------------------------------------------

  editAssociations(
    id: string,
    edits: AssociationEdit[],
    opts?: ElementWriteOptions<DataAssociation>,
  ): Promise<StackRecord> {
    return this.record.editAssociations(id, edits, opts);
  }

  setAssociations(
    id: string,
    associations: DataAssociation[],
    opts?: ElementWriteOptions<DataAssociation>,
  ): Promise<StackRecord> {
    return this.record.setAssociations(id, associations, opts);
  }

  editAccess(
    id: string,
    edits: AssociationEdit[],
    opts?: ElementWriteOptions<AuthorityAssociation>,
  ): Promise<StackRecord> {
    return this.record.editAccess(id, edits, opts);
  }

  setAccess(
    id: string,
    permissions: AuthorityAssociation[],
    opts?: ElementWriteOptions<AuthorityAssociation>,
  ): Promise<StackRecord> {
    return this.record.setAccess(id, permissions, opts);
  }

  // -------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------

  abstract flush(): Promise<void>;
  abstract close(): Promise<void>;
}
