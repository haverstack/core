/**
 * Wraps DoSQLiteRecordAdapter in a real DurableObject subclass, the way a
 * consuming Worker would — this IS the reference shape for that wiring,
 * not test-only scaffolding around it. Every method is a thin RPC
 * pass-through: Workers RPC serializes plain data (including Date, via
 * structured clone) across the stub boundary, but not class instances, so
 * each StackRecordAdapter method needs its own exposed method here.
 */
import { DurableObject } from 'cloudflare:workers';
import { DoSQLiteRecordAdapter } from '../../src/index.js';
import type {
  StackRecord,
  StackQuery,
  Association,
  Permission,
  RecordVersion,
  StackType,
  TypeId,
  FileId,
  ActorOptions,
} from '@haverstack/core';

type MutationOpts = { expectedVersion?: number; snapshot?: RecordVersion } & ActorOptions;

export class TestRecordAdapterDO extends DurableObject {
  private adapter!: DoSQLiteRecordAdapter;
  private readonly ready: Promise<void>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ready = ctx.blockConcurrencyWhile(async () => {
      this.adapter = await DoSQLiteRecordAdapter.create(ctx.storage, {
        entityId: 'entity-test',
        timezone: 'America/New_York',
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

  async deleteRecord(id: string, opts?: { hard?: boolean } & MutationOpts) {
    await this.ready;
    return this.adapter.deleteRecord(id, opts);
  }

  async undeleteRecord(id: string, opts?: MutationOpts) {
    await this.ready;
    return this.adapter.undeleteRecord(id, opts);
  }

  async setPermissions(id: string, permissions: Permission[], opts?: MutationOpts) {
    await this.ready;
    return this.adapter.setPermissions(id, permissions, opts);
  }

  async setUnlisted(id: string, unlisted: boolean, opts?: MutationOpts) {
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

  async queryRecords(query: StackQuery) {
    await this.ready;
    return this.adapter.queryRecords(query);
  }

  async deleteUnreferencedAttachmentRecords(fileId: FileId, metadataTypeId: TypeId) {
    await this.ready;
    return this.adapter.deleteUnreferencedAttachmentRecords(fileId, metadataTypeId);
  }

  async getVersions(id: string) {
    await this.ready;
    return this.adapter.getVersions(id);
  }

  async getVersion(id: string, version: number) {
    await this.ready;
    return this.adapter.getVersion(id, version);
  }

  async saveVersion(id: string, version: RecordVersion) {
    await this.ready;
    return this.adapter.saveVersion(id, version);
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

  async associate(recordId: string, association: Association, opts?: MutationOpts) {
    await this.ready;
    return this.adapter.associate(recordId, association, opts);
  }

  async dissociate(recordId: string, association: Association, opts?: MutationOpts) {
    await this.ready;
    return this.adapter.dissociate(recordId, association, opts);
  }
}

export default {
  async fetch(): Promise<Response> {
    return new Response('test worker: use RPC stub methods');
  },
};
