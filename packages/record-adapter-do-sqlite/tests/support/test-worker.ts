/**
 * Wraps DoSQLiteRecordAdapter in a real DurableObject subclass, the way a
 * consuming Worker would — this IS the reference shape for that wiring,
 * not test-only scaffolding around it. Every method is a thin RPC
 * pass-through: Workers RPC serializes plain data (including Date, via
 * structured clone) across the stub boundary, but not class instances, so
 * each StackRecordAdapter method needs its own exposed method here.
 */
import { DurableObject } from 'cloudflare:workers';
import type {
  AdapterQuery,
  ElementWriteOptions,
  OwnerMismatchError,
  Reach,
  RecordHistory,
} from '@haverstack/core/adapter';
import { DoSQLiteRecordAdapter } from '../../src/index.js';
import type {
  StackRecord,
  AssociationEdit,
  AuthorityAssociation,
  DataAssociation,
  RecordVersion,
  StackType,
  TypeId,
  BaseId,
  FileId,
  ActorOptions,
} from '@haverstack/core';

type MutationOpts = { ifVersion?: number; snapshot?: RecordVersion } & ActorOptions;
type AspectOpts = { ifVersion?: number };
type DataOpts = ElementWriteOptions<DataAssociation>;
type AccessOpts = ElementWriteOptions<AuthorityAssociation>;

export class TestRecordAdapterDO extends DurableObject {
  private adapter!: DoSQLiteRecordAdapter;
  private readonly ready: Promise<void>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ready = ctx.blockConcurrencyWhile(async () => {
      this.adapter = await DoSQLiteRecordAdapter.open(ctx.storage, {
        ownerEntityId: 'entity-test',
      });
    });
  }

  async getCapabilities() {
    await this.ready;
    return this.adapter.capabilities;
  }

  async getOwnerEntityId() {
    await this.ready;
    return this.adapter.ownerEntityId;
  }

  /** Re-opens this DO's storage with `owner`; reports what happened, since an error can't cross RPC typed. */
  async reopen(
    owner: string,
  ): Promise<{ owner: string } | { error: string; expected?: string; actual?: string }> {
    await this.ready;
    let called = false;
    const ownerEntityId =
      owner === 'lazy:unused'
        ? () => {
            called = true;
            return 'lazy-owner';
          }
        : owner;
    try {
      const reopened = await DoSQLiteRecordAdapter.open(this.ctx.storage, { ownerEntityId });
      if (called) return { error: 'LazyProviderCalled' };
      return { owner: reopened.ownerEntityId };
    } catch (err) {
      const e = err as OwnerMismatchError;
      return { error: e.name, expected: e.expected, actual: e.actual };
    }
  }

  async createRecord(record: StackRecord) {
    await this.ready;
    return this.adapter.createRecord(record);
  }

  async getRecord(id: string) {
    await this.ready;
    return this.adapter.getRecord(id);
  }

  async patchContent(id: string, patch: Record<string, unknown | null>, opts?: MutationOpts) {
    await this.ready;
    return this.adapter.patchContent(id, patch, opts);
  }

  async deleteRecord(id: string, opts?: { purge?: boolean } & MutationOpts) {
    await this.ready;
    return this.adapter.deleteRecord(id, opts);
  }

  async undeleteRecord(id: string, opts?: MutationOpts) {
    await this.ready;
    return this.adapter.undeleteRecord(id, opts);
  }

  async setParent(id: string, parentId: string | null, opts?: AspectOpts) {
    await this.ready;
    return this.adapter.setParent(id, parentId, opts);
  }

  async setUnlisted(id: string, unlisted: boolean, opts?: AspectOpts) {
    await this.ready;
    return this.adapter.setUnlisted(id, unlisted, opts);
  }

  async restoreVersion(id: string, version: number, opts?: MutationOpts) {
    await this.ready;
    return this.adapter.restoreVersion(id, version, opts);
  }

  async commitMigration(
    id: string,
    toTypeId: TypeId,
    content: Record<string, unknown>,
    opts?: MutationOpts,
  ) {
    await this.ready;
    return this.adapter.commitMigration(id, toTypeId, content, opts);
  }

  async queryRecords(query: AdapterQuery) {
    await this.ready;
    return this.adapter.queryRecords(query);
  }

  async queryReadable(query: AdapterQuery, reach: Reach) {
    await this.ready;
    return this.adapter.queryReadable(query, reach);
  }

  async deleteUnreferencedAttachmentRecords(fileId: FileId, metadataBaseId: BaseId) {
    await this.ready;
    return this.adapter.deleteUnreferencedAttachmentRecords(fileId, metadataBaseId);
  }

  async getVersions(id: string) {
    await this.ready;
    return this.adapter.getVersions(id);
  }

  async getVersion(id: string, version: number) {
    await this.ready;
    return this.adapter.getVersion(id, version);
  }

  async getJournal(id: string) {
    await this.ready;
    return this.adapter.getJournal(id);
  }

  async importRecord(record: StackRecord, history: RecordHistory) {
    await this.ready;
    return this.adapter.importRecord(record, history);
  }

  async saveType(type: StackType) {
    await this.ready;
    return this.adapter.saveType(type);
  }

  async getType(id: TypeId) {
    await this.ready;
    return this.adapter.getType(id);
  }

  async listTypes() {
    await this.ready;
    return this.adapter.listTypes();
  }

  async editAssociations(id: string, edits: AssociationEdit[], opts?: DataOpts) {
    await this.ready;
    return this.adapter.editAssociations(id, edits, opts);
  }

  async setAssociations(id: string, associations: DataAssociation[], opts?: DataOpts) {
    await this.ready;
    return this.adapter.setAssociations(id, associations, opts);
  }

  async editAccess(id: string, edits: AssociationEdit[], opts?: AccessOpts) {
    await this.ready;
    return this.adapter.editAccess(id, edits, opts);
  }

  async setAccess(id: string, permissions: AuthorityAssociation[], opts?: AccessOpts) {
    await this.ready;
    return this.adapter.setAccess(id, permissions, opts);
  }
}

export default {
  async fetch(): Promise<Response> {
    return new Response('test worker: use RPC stub methods');
  },
};
