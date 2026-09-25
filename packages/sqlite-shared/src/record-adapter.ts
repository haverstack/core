/**
 * The engine-independent half of a SQLite-backed StackRecordAdapter: the
 * capability declaration and the delegation of all seventeen
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
  RecordJournalEntry,
  StackType,
  TypeId,
  FileId,
  RecordVersion,
  ActorOptions,
  StackRecord,
  StackQuery,
  QueryResult,
  Association,
  RecordChanges,
} from '@haverstack/core';
import type {
  StackRecordAdapter,
  AdapterCapabilities,
  JournalOptions,
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
export const SQLITE_RECORD_CAPABILITIES: AdapterCapabilities = {
  filter: {
    content: 'path',
    contentPresent: true,
    search: true,
  },
  sort: {
    fields: ['createdAt', 'updatedAt', 'version'],
    contentField: true,
  },
  limits: {
    attachmentBytes: null,
    contentBytes: null,
  },
};

export abstract class SharedSqlRecordAdapter implements StackRecordAdapter {
  readonly capabilities: AdapterCapabilities = SQLITE_RECORD_CAPABILITIES;

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

  mutateRecord(
    id: string,
    changes: RecordChanges,
    opts?: {
      expectedVersion?: number;
      snapshot?: RecordVersion;
      bumpsVersion?: boolean;
    } & ActorOptions &
      JournalOptions,
  ): Promise<StackRecord> {
    return this.record.mutateRecord(id, changes, opts);
  }

  deleteRecord(
    id: string,
    opts?: { hard?: boolean; expectedVersion?: number; snapshot?: RecordVersion } & ActorOptions &
      JournalOptions,
  ): Promise<StackRecord | null> {
    return this.record.deleteRecord(id, opts);
  }

  undeleteRecord(
    id: string,
    opts?: { expectedVersion?: number; snapshot?: RecordVersion } & ActorOptions & JournalOptions,
  ): Promise<StackRecord> {
    return this.record.undeleteRecord(id, opts);
  }

  restoreVersion(
    id: string,
    version: number,
    opts?: { expectedVersion?: number; snapshot?: RecordVersion } & ActorOptions & JournalOptions,
  ): Promise<StackRecord> {
    return this.record.restoreVersion(id, version, opts);
  }

  commitMigration(
    id: string,
    toTypeId: TypeId,
    content: Record<string, unknown>,
    opts?: { expectedVersion?: number; snapshot?: RecordVersion } & ActorOptions & JournalOptions,
  ): Promise<StackRecord> {
    return this.record.commitMigration(id, toTypeId, content, opts);
  }

  queryRecords(query: StackQuery): Promise<QueryResult> {
    return this.record.queryRecords(query);
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

  getVersions(id: string): Promise<RecordVersion[]> {
    return this.record.getVersions(id);
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
  // Associations
  // -------------------------------------------------------

  associate(
    recordId: string,
    association: Association,
    opts?: JournalOptions,
  ): Promise<StackRecord> {
    return this.record.associate(recordId, association, opts);
  }

  dissociate(
    recordId: string,
    association: Association,
    opts?: JournalOptions,
  ): Promise<StackRecord> {
    return this.record.dissociate(recordId, association, opts);
  }

  // -------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------

  abstract flush(): Promise<void>;
  abstract close(): Promise<void>;
}
