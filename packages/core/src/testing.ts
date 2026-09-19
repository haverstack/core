import type {
  StackAdapter,
  StackRecord,
  StackType,
  TypeId,
  RecordVersion,
  RecordJournalEntry,
  JournalEntryInput,
  JournalOptions,
  JournalQuery,
  RecordChanges,
  ActorOptions,
  StackQuery,
  QueryResult,
  RecordFilter,
  Association,
  AuthorityAssociation,
  DataAssociation,
  AdapterCapabilities,
  BlobFileInfo,
  QuerySort,
} from './types.js';
import { SYSTEM_TYPES } from './types.js';
import { applyMergePatch } from './merge.js';
import { compareSortEntries, contentSortEntry } from './sort.js';
import type { SortEntry } from './sort.js';
import {
  StackVersionConflictError,
  StackConflictError,
  StackNotFoundError,
  StackQueryError,
} from './errors.js';
import { parseContentFilterKey } from './query-validation.js';
import { associationEqual } from './record-changes.js';

/** An array stands for its elements; anything else stands for itself. */
const spreadValue = (value: unknown): unknown[] => (Array.isArray(value) ? value : [value]);

/** A FileId is the SHA-256 hex digest of its bytes — see docs/spec/attachments.md. */
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

/**
 * Every value reachable by walking `segments`, spreading arrays
 * element-wise at each step — the same walk sqlite-shared's
 * contentPathExists() performs in SQL, and the reason a filter answers the
 * same question against either. An empty result means the path reaches
 * nothing, which is what a `null` filter value matches.
 * See docs/spec/data-model.md § Nested content paths.
 */
const valuesAtContentPath = (content: Record<string, unknown>, segments: string[]): unknown[] => {
  let current: unknown[] = [content];
  for (const segment of segments) {
    const next: unknown[] = [];
    for (const value of current) {
      for (const item of spreadValue(value)) {
        if (typeof item !== 'object' || item === null || Array.isArray(item)) continue;
        if (Object.hasOwn(item, segment)) next.push((item as Record<string, unknown>)[segment]);
      }
    }
    current = next;
  }
  // The leaf spreads too, so a filter on `tags` matches a record whose
  // `tags` array contains the value.
  return current.flatMap(spreadValue);
};

/**
 * In-memory StackAdapter with offset-based cursor pagination. Implements
 * the full RecordFilter shape (mirroring sqlite-shared's recordConditions)
 * so permission logic under test exercises real predicates. Declares
 * `filter.content: 'path'`, as every local adapter must; tests needing
 * the capability-gated paths use IncapableMemoryAdapter below.
 */
export class MemoryAdapter implements StackAdapter {
  readonly capabilities: AdapterCapabilities = {
    filter: {
      content: 'path',
      contentPresent: true,
      search: false,
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

  readonly ownerEntityId: string;
  readonly timezone: string | undefined;

  readonly records = new Map<string, StackRecord>();
  readonly order: string[] = [];
  readonly versions = new Map<string, RecordVersion[]>();
  readonly journals = new Map<string, RecordJournalEntry[]>();
  readonly types = new Map<string, StackType>();
  readonly blobs = new Map<string, { data: Uint8Array; modifiedAt: Date }>();

  constructor({
    ownerEntityId = '',
    timezone,
  }: { ownerEntityId?: string; timezone?: string } = {}) {
    this.ownerEntityId = ownerEntityId;
    this.timezone = timezone;
  }

  async createRecord(record: StackRecord, opts: JournalOptions = {}) {
    if (this.records.has(record.id)) {
      throw new StackConflictError(`Record already exists: "${record.id}"`);
    }
    this.records.set(record.id, { ...record });
    this.order.push(record.id);
    this.appendJournal(record.id, opts.journal, record);
    return record;
  }

  async getRecord(id: string) {
    return this.records.get(id) ?? null;
  }

  /**
   * Advance a record one version, restamping the actor. An absent actor
   * clears the previous one rather than inheriting it — an unscoped write
   * names no requester, and carrying the last one forward would attribute
   * it to whoever happened to touch the record before.
   */
  private bump(record: StackRecord, actor: ActorOptions = {}): StackRecord {
    const { updatedBy: _by, updatedVia: _via, ...rest } = record;
    return {
      ...rest,
      version: record.version + 1,
      updatedAt: new Date(),
      ...(actor.updatedBy && { updatedBy: actor.updatedBy }),
      ...(actor.updatedVia && { updatedVia: actor.updatedVia }),
    };
  }

  /** Opt-in CAS check mirroring the real adapters' expectedVersion contract. */
  private checkExpectedVersion(record: StackRecord, expectedVersion: number | undefined): void {
    if (expectedVersion === undefined || record.version === expectedVersion) return;
    throw new StackVersionConflictError(
      `Record "${record.id}" is at version ${record.version}, expected ${expectedVersion}`,
      record.id,
      expectedVersion,
      record.version,
    );
  }

  /**
   * True if any top-level file-ref field in the record's registered type
   * schema currently holds this fileId — the content-reference half of
   * attachmentFileId matching. Mirrors sqlite-shared's content_index,
   * computed on the fly since MemoryAdapter has no persisted index.
   */
  private hasFileRefTo(record: StackRecord, fileId: string): boolean {
    const schema = this.types.get(record.typeId)?.schema;
    if (!schema) return false;
    const content = record.content as Record<string, unknown>;
    return Object.entries(schema).some(
      ([field, def]) => def.kind === 'file-ref' && content[field] === fileId,
    );
  }

  async mutateRecord(
    id: string,
    changes: RecordChanges,
    opts: {
      expectedVersion?: number;
      snapshot?: RecordVersion;
      bumpsVersion?: boolean;
    } & ActorOptions &
      JournalOptions = {},
  ) {
    const existing = this.records.get(id);
    if (!existing) throw new StackNotFoundError(`Record not found: "${id}"`);
    this.checkExpectedVersion(existing, opts.expectedVersion);
    if (opts.snapshot) this.snapshotBeforeMutation(id, opts.snapshot);

    // Destructured out so each optional native field is re-added only when
    // the change set leaves it set — assigning `undefined` would leave the
    // key present, which is how a record grows a `parentId: undefined` that
    // every `in` check then reads as a container.
    const { parentId: _p, unlistedAt: _u, ...rest } = existing;
    let next: StackRecord = rest as StackRecord;

    if (changes.contentPatch) {
      next = { ...next, content: applyMergePatch(next.content, changes.contentPatch) };
    }
    // Each key replaces only within its own half of the partition, which
    // is what keeps a tag write from touching an ACL it was never shown.
    if (changes.permissions) next = withPermissions(next, changes.permissions);
    if (changes.associations) next = withAssociations(next, changes.associations);

    const parentId =
      changes.parentId !== undefined ? changes.parentId : (existing.parentId ?? null);
    if (parentId !== null) next = { ...next, parentId };

    const unlisted =
      changes.unlisted !== undefined ? changes.unlisted : Boolean(existing.unlistedAt);
    if (unlisted) next = { ...next, unlistedAt: existing.unlistedAt ?? new Date() };

    // A change set touching only `associations` doesn't bump — see
    // docs/spec/versioning.md § Version history. `next` already carries
    // the prior version/updatedAt/updatedBy/updatedVia untouched.
    const updated = opts.bumpsVersion === false ? next : this.bump(next, opts);
    this.records.set(id, updated);
    this.appendJournal(id, opts.journal, updated);
    return updated;
  }

  async deleteRecord(
    id: string,
    opts: {
      hard?: boolean;
      expectedVersion?: number;
      snapshot?: RecordVersion;
    } & ActorOptions &
      JournalOptions = {},
  ) {
    const record = this.records.get(id);
    if (!record) {
      // A hard delete with nothing to fence is the one case the SQL
      // adapters answer silently; every other shape of this call reports a
      // record that isn't there, and a fixture that shrugged instead would
      // pass tests the real adapters fail.
      if (opts.hard && opts.expectedVersion === undefined) return null;
      throw new StackNotFoundError(`Record not found: "${id}"`);
    }
    this.checkExpectedVersion(record, opts.expectedVersion);
    if (opts.hard) {
      this.records.delete(id);
      this.order.splice(this.order.indexOf(id), 1);
      // A purge takes the version history and the journal with it: what a
      // destroyed record once held is exactly the residue this verb exists
      // to leave nothing of.
      this.versions.delete(id);
      this.journals.delete(id);
      return record;
    }
    if (opts.snapshot) this.snapshotBeforeMutation(id, opts.snapshot);
    const deleted = this.bump({ ...record, deletedAt: new Date() }, opts);
    this.records.set(id, deleted);
    this.appendJournal(id, opts.journal, deleted);
    return deleted;
  }

  async undeleteRecord(
    id: string,
    opts: { expectedVersion?: number; snapshot?: RecordVersion } & ActorOptions &
      JournalOptions = {},
  ) {
    const record = this.records.get(id);
    if (!record) throw new StackNotFoundError(`Record not found: "${id}"`);
    this.checkExpectedVersion(record, opts.expectedVersion);
    if (opts.snapshot) this.snapshotBeforeMutation(id, opts.snapshot);
    const { deletedAt: _deletedAt, ...rest } = record;
    const updated = this.bump(rest as StackRecord, opts);
    this.records.set(id, updated);
    this.appendJournal(id, opts.journal, updated);
    return updated;
  }

  /** Cursor is a stringified offset into insertion order. */
  async queryRecords(query: StackQuery): Promise<QueryResult> {
    const f = query.filter ?? {};
    let results = this.order.map((id) => this.records.get(id)!);
    // _config is addressable only by ID (getRecord), never returned by a
    // generic query — mirroring the real SQL adapters' WHERE exclusion.
    results = results.filter((r) => r.id !== SYSTEM_TYPES.CONFIG);
    if (!f.includeDeleted) results = results.filter((r) => !r.deletedAt);
    if (!f.includeUnlisted) results = results.filter((r) => !r.unlistedAt);
    if (f.typeId) {
      const ids = Array.isArray(f.typeId) ? f.typeId : [f.typeId];
      results = results.filter((r) => ids.includes(r.typeId));
    }
    if (f.parentId !== undefined) {
      results =
        f.parentId === null
          ? results.filter((r) => !r.parentId)
          : results.filter((r) => r.parentId === f.parentId);
    }
    if (f.appId !== undefined) {
      const ids = Array.isArray(f.appId) ? f.appId : [f.appId];
      results = results.filter((r) => r.appId !== undefined && ids.includes(r.appId));
    }
    if (f.entityId !== undefined) {
      const ids = Array.isArray(f.entityId) ? f.entityId : [f.entityId];
      results = results.filter((r) => r.entityId !== undefined && ids.includes(r.entityId));
    }
    if (f.principalId !== undefined) {
      const ids = Array.isArray(f.principalId) ? f.principalId : [f.principalId];
      results = results.filter((r) => r.principalId !== undefined && ids.includes(r.principalId));
    }
    if (f.createdAt?.after) results = results.filter((r) => r.createdAt > f.createdAt!.after!);
    if (f.createdAt?.before) results = results.filter((r) => r.createdAt < f.createdAt!.before!);
    if (f.updatedAt?.after) results = results.filter((r) => r.updatedAt > f.updatedAt!.after!);
    if (f.updatedAt?.before) results = results.filter((r) => r.updatedAt < f.updatedAt!.before!);
    if (f.tags?.length) {
      const tags = f.tags;
      results = results.filter((r) =>
        tags.every((tag) =>
          (r.associations ?? []).some((a) => a.kind === 'tag' && a.label === tag),
        ),
      );
    }
    if (f.hasAttachment) {
      results = results.filter((r) =>
        (r.associations ?? []).some((a) => a.kind === 'attachment' && a.label === f.hasAttachment),
      );
    }
    if (f.attachmentFileId) {
      const fileId = f.attachmentFileId;
      results = results.filter(
        (r) =>
          (r.associations ?? []).some((a) => a.kind === 'attachment' && a.fileId === fileId) ||
          this.hasFileRefTo(r, fileId),
      );
    }
    if (f.relatedTo) {
      const relatedTo = f.relatedTo;
      results = results.filter((r) => matchesRelatedTo(r.associations, relatedTo));
    }
    // A `null` filter value means "field absent or null" — not "match
    // nothing". Plain `===` would miss an absent field; treat both as
    // satisfying a null filter (docs/spec/data-model.md § Filter).
    if (f.content) {
      const entries = Object.entries(f.content).map(
        ([key, value]) => [parseContentFilterKey(key), value] as const,
      );
      results = results.filter((r) =>
        entries.every(([segments, value]) => {
          const found = valuesAtContentPath(r.content as Record<string, unknown>, segments);
          if (value === null || value === undefined) {
            return found.length === 0 || found.some((v) => v === null || v === undefined);
          }
          return found.some((v) => v === value);
        }),
      );
    }

    results = this.sortRecords(results, query.sort);

    // Element-wise like the content filter above: a path holds a value
    // when at least one non-null value is reachable at it.
    if (f.contentPresent?.length) {
      const paths = f.contentPresent.map((key) => parseContentFilterKey(key));
      results = results.filter((r) =>
        paths.every((segments) =>
          valuesAtContentPath(r.content as Record<string, unknown>, segments).some(
            (v) => v !== null && v !== undefined,
          ),
        ),
      );
    }

    const limit = query.limit ?? 50;
    const start = query.cursor ? this.decodeCursor(query.cursor, query.sort) : 0;
    const page = results.slice(start, start + limit);
    const nextStart = start + limit;
    const cursor = nextStart < results.length ? this.encodeCursor(query.sort, nextStart) : null;

    return { records: page, cursor };
  }

  /** The sort a cursor was minted under, as an opaque comparable descriptor. */
  private sortDescriptor(sort: QuerySort | undefined): string {
    return JSON.stringify([
      sort?.contentField ?? null,
      sort?.contentField === undefined ? (sort?.field ?? 'createdAt') : null,
      sort?.direction ?? 'desc',
    ]);
  }

  /**
   * Stringified offset into insertion order, paired with the sort it was
   * minted under — mirroring the real adapters' cursor stability guarantee.
   * See docs/spec/data-model.md § Sorting and pagination.
   */
  private encodeCursor(sort: QuerySort | undefined, offset: number): string {
    const json = JSON.stringify({ d: this.sortDescriptor(sort), o: offset });
    // Explicit UTF-8 step before btoa, matching sqlite-shared's codec: the
    // descriptor embeds `sort.contentField` verbatim, and a non-Latin-1
    // field name would otherwise make btoa throw an InvalidCharacterError
    // (a DOMException, not a StackError) out of an otherwise valid query.
    const bytes = new TextEncoder().encode(json);
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  }

  /**
   * Throws StackQueryError for a cursor that doesn't decode at all, or one
   * minted under a different sort than `sort` names — the same refusal a
   * cursor replayed under a changed sort gets from the real adapters,
   * rather than silently paging through the wrong order.
   */
  private decodeCursor(cursor: string, sort: QuerySort | undefined): number {
    let parsed: unknown;
    try {
      const binary = atob(cursor);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      parsed = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      throw new StackQueryError(`Malformed cursor: "${cursor}"`);
    }
    const { d, o } = (parsed ?? {}) as { d?: unknown; o?: unknown };
    // `o >= 0` is part of being well-formed, not a nicety: a crafted
    // negative offset would reach `results.slice(-3, ...)` and hand back
    // the tail of the result set as "the next page". Cursors arrive from
    // the wire uninspected (wire-request copies `?cursor=` verbatim), so
    // this is the only place the offset is checked at all.
    if (typeof d !== 'string' || typeof o !== 'number' || !Number.isInteger(o) || o < 0) {
      throw new StackQueryError(`Malformed cursor: "${cursor}"`);
    }
    if (d !== this.sortDescriptor(sort)) {
      throw new StackQueryError(`Cursor was minted under a different sort than this query names.`);
    }
    return o;
  }

  /**
   * Order a result set the way a materialized sort index does: absent
   * values last in both directions, numbers before text, and `id` as the
   * final tiebreak so a page boundary falls in the same place twice.
   * The comparison itself is core's, not this double's
   * (docs/spec/data-model.md § Sorting by a content field).
   */
  private sortRecords(records: StackRecord[], sort: QuerySort | undefined): StackRecord[] {
    const direction = sort?.direction ?? 'desc';
    const sign = direction === 'asc' ? 1 : -1;
    const byId = (a: StackRecord, b: StackRecord) => (a.id < b.id ? -sign : a.id > b.id ? sign : 0);

    if (sort?.contentField === undefined) {
      const field = sort?.field ?? 'createdAt';
      const value = (r: StackRecord) =>
        field === 'version'
          ? r.version
          : (field === 'updatedAt' ? r.updatedAt : r.createdAt).getTime();
      return [...records].sort((a, b) => sign * (value(a) - value(b)) || byId(a, b));
    }

    const field = sort.contentField;
    const entries = new Map(records.map((r) => [r.id, this.sortEntry(r, field)]));
    return [...records].sort(
      (a, b) => compareSortEntries(entries.get(a.id)!, entries.get(b.id)!, direction) || byId(a, b),
    );
  }

  /**
   * The record's ordered value at `field`, or null when it holds none.
   * Read through the declared schema — a field only orders as the kind
   * its type says it is, and an undeclared or non-scalar field orders as
   * nothing at all.
   */
  private sortEntry(record: StackRecord, field: string): SortEntry | null {
    const def = this.types.get(record.typeId)?.schema[field];
    if (!def || def.kind === 'array' || def.kind === 'object') return null;
    return contentSortEntry(def.kind, (record.content as Record<string, unknown>)[field]);
  }

  /** Never bumps `version`/`updatedAt` — see StackRecordAdapter.associate(). */
  async associate(id: string, association: Association, opts: JournalOptions = {}) {
    const record = this.records.get(id);
    if (!record) throw new StackNotFoundError(`Record not found: "${id}"`);
    // Upsert on identity, mirroring the SQLite adapters' ON CONFLICT: a
    // re-pointed `attachmentRecordId` lands on the association already
    // there rather than adding a second reference to the same file. Both
    // halves of the partition share one table, so both reach this verb.
    const assocs = allAssociations(record);
    const next = assocs.some((a) => associationEqual(a, association))
      ? assocs.map((a) => (associationEqual(a, association) ? association : a))
      : [...assocs, association];
    const updated = withAssociationSet(record, next);
    this.records.set(id, updated);
    this.appendJournal(id, opts.journal, updated);
    return updated;
  }

  /** Never bumps `version`/`updatedAt` — see associate(). */
  async dissociate(id: string, association: Association, opts: JournalOptions = {}) {
    const record = this.records.get(id);
    if (!record) throw new StackNotFoundError(`Record not found: "${id}"`);
    const assocs = allAssociations(record).filter((a) => !associationEqual(a, association));
    const updated = withAssociationSet(record, assocs);
    this.records.set(id, updated);
    this.appendJournal(id, opts.journal, updated);
    return updated;
  }

  async getVersions(id: string) {
    return this.versions.get(id) ?? [];
  }
  async getVersion(id: string, version: number) {
    return (this.versions.get(id) ?? []).find((v) => v.version === version) ?? null;
  }

  /**
   * Loud on a (record, version) collision, mirroring the real adapters'
   * UNIQUE constraint.
   */
  private insertVersionRow(id: string, version: RecordVersion): void {
    const existing = this.versions.get(id) ?? [];
    if (existing.some((v) => v.version === version.version)) {
      throw new StackConflictError(
        `Version ${version.version} already exists for record "${id}" — a concurrent ` +
          `writer raced past this version. Use ifVersion to detect this before it happens.`,
      );
    }
    this.versions.set(id, [...existing, version]);
  }

  /**
   * Standalone snapshot write for tooling and tests — loud on any
   * collision, since nothing here is about to bump the record's version.
   * Mutating methods take a `snapshot` option instead; see
   * snapshotBeforeMutation.
   */
  async saveVersion(id: string, version: RecordVersion) {
    this.insertVersionRow(id, version);
  }

  /**
   * The snapshot half of a mutating method's atomic snapshot-then-mutate
   * step. Mirrors the real adapters' snapshotBeforeMutation (see
   * sqlite-shared/record-logic.ts for the full rationale): a collision is
   * rejected loudly, except an orphan row at the record's current version,
   * which is overwritten so the interrupted write can finally complete.
   */
  private snapshotBeforeMutation(id: string, version: RecordVersion): void {
    const existing = this.versions.get(id) ?? [];
    const collision = existing.some((v) => v.version === version.version);
    if (!collision) {
      this.versions.set(id, [...existing, version]);
      return;
    }

    const record = this.records.get(id);
    if (!record || record.version !== version.version) {
      throw new StackConflictError(
        `Version ${version.version} already exists for record "${id}" — a concurrent ` +
          `writer raced past this version. Use ifVersion to detect this before it happens.`,
      );
    }

    this.versions.set(
      id,
      existing.map((v) => (v.version === version.version ? version : v)),
    );
  }

  async restoreVersion(
    id: string,
    version: number,
    opts: {
      expectedVersion?: number;
      snapshot?: RecordVersion;
    } & ActorOptions &
      JournalOptions = {},
  ) {
    const record = this.records.get(id);
    if (!record) throw new StackNotFoundError(`Record not found: "${id}"`);
    this.checkExpectedVersion(record, opts.expectedVersion);
    const target = (this.versions.get(id) ?? []).find((v) => v.version === version);
    if (!target) throw new StackNotFoundError(`Version not found: "${id}"@${version}`);
    if (opts.snapshot) this.snapshotBeforeMutation(id, opts.snapshot);
    // Content and its type are all a snapshot carries — containment,
    // listing and associations are left exactly where they stand.
    const merged = { ...record, typeId: target.typeId, content: target.content };
    const updated = this.bump(merged, opts);
    this.records.set(id, updated);
    this.appendJournal(id, opts.journal, updated);
    return updated;
  }

  async commitMigration(
    id: string,
    toTypeId: TypeId,
    content: Record<string, unknown>,
    opts: { expectedVersion?: number; snapshot?: RecordVersion } & ActorOptions &
      JournalOptions = {},
  ) {
    const record = this.records.get(id);
    if (!record) throw new StackNotFoundError(`Record not found: "${id}"`);
    this.checkExpectedVersion(record, opts.expectedVersion);
    if (opts.snapshot) this.snapshotBeforeMutation(id, opts.snapshot);
    const updated = this.bump({ ...record, typeId: toTypeId, content }, opts);
    this.records.set(id, updated);
    this.appendJournal(id, opts.journal, updated);
    return updated;
  }

  /**
   * Append one entry, stamping the record-derived half from the row as it
   * now stands. `seq` is allocated here rather than by the caller, which
   * is what keeps the journal free of the collision healing a snapshot's
   * caller-computed version number needs.
   */
  private appendJournal(
    id: string,
    entry: JournalEntryInput | undefined,
    record: StackRecord,
  ): void {
    if (!entry) return;
    const log = this.journals.get(id) ?? [];
    log.push({
      ...entry,
      seq: log.length + 1,
      at: new Date(),
      version: record.version,
      typeId: record.typeId,
      ...(record.parentId !== undefined && { parentId: record.parentId }),
    });
    this.journals.set(id, log);
  }

  async getJournal(id: string, query: JournalQuery = {}): Promise<RecordJournalEntry[]> {
    // An empty log means "nothing changed" unconditionally, so a record
    // that isn't there cannot be spelled that way.
    // See docs/spec/journal.md § Reading it.
    if (!this.records.has(id)) throw new StackNotFoundError(`Record not found: "${id}"`);
    const log = this.journals.get(id) ?? [];
    const after = query.sinceSeq === undefined ? log : log.filter((e) => e.seq > query.sinceSeq!);
    return query.limit === undefined ? after : after.slice(0, query.limit);
  }

  async saveType(type: StackType) {
    this.types.set(type.id, type);
  }
  async getType(id: TypeId) {
    return this.types.get(id) ?? null;
  }
  async listTypes() {
    return [...this.types.values()];
  }

  /** Content-addressed, like the real adapters — needed so file-ref values (SHA-256 hex) validate. */
  async putAttachment(data: Uint8Array): Promise<string> {
    const hashBuffer = await crypto.subtle.digest('SHA-256', data as BufferSource);
    const fileId = Array.from(new Uint8Array(hashBuffer))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    if (!this.blobs.has(fileId)) {
      this.blobs.set(fileId, { data, modifiedAt: new Date() });
    }
    return fileId;
  }
  async getAttachment(fileId: string): Promise<Uint8Array> {
    if (!SHA256_HEX_RE.test(fileId)) {
      throw new StackQueryError(`Invalid fileId: expected 64-character lowercase hex string`);
    }
    const blob = this.blobs.get(fileId);
    if (!blob) throw new StackNotFoundError(`Attachment not found: "${fileId}"`);
    return blob.data;
  }
  async deleteAttachment(fileId: string) {
    this.blobs.delete(fileId);
  }
  // Declared as an optional field (not a fixed method) so a test subclass
  // can override it to `undefined`, simulating an adapter that doesn't
  // implement this capability (see stack.test.ts's NoListFilesAdapter).
  listFiles?: () => Promise<BlobFileInfo[]> = async () => {
    return [...this.blobs.entries()].map(([fileId, blob]) => ({
      fileId,
      size: blob.data.byteLength,
      modifiedAt: blob.modifiedAt,
    }));
  };

  flush?: () => Promise<void>;
  close?: () => Promise<void>;
}

/**
 * A MemoryAdapter reaching no content at all, simulating the one
 * legitimate case: a wire adapter whose server declined it
 * (docs/spec/adapters.md § Adapter capabilities). For exercising Stack's
 * capability-gated fallbacks and the fail-loud assertQueryCapabilities
 * check in tests; not a stand-in for a real local adapter.
 */
export class IncapableMemoryAdapter extends MemoryAdapter {
  override readonly capabilities: AdapterCapabilities = {
    filter: {
      content: 'none',
      contentPresent: false,
      search: false,
    },
    sort: {
      fields: ['createdAt', 'updatedAt', 'version'],
      contentField: false,
    },
    limits: {
      attachmentBytes: null,
      contentBytes: null,
    },
  };
}

/** Whether an association carries authority — mirrors core's own predicate. */
const isAuthority = (a: Association): a is AuthorityAssociation =>
  a.kind === 'permission' || a.kind === 'anyone';

/**
 * A record's whole association table, both projections rejoined — what
 * associate()/dissociate() act on, since storage keys all kinds alike.
 */
function allAssociations(record: StackRecord): Association[] {
  return [...(record.associations ?? []), ...(record.permissions ?? [])];
}

/**
 * Sets a record's association set, keyed by identity as every adapter's
 * association table is: a list naming one identity twice collapses to one
 * entry, last wins. Core refuses such a list before an adapter sees it —
 * this is what keeps a direct caller from reaching a state a SQL store
 * cannot represent. Both projections are written, omitting either key when
 * empty — mirroring the SQL adapters' rowToRecord, so the same mutation
 * sequence produces identically-shaped records on the test double and real
 * storage. See docs/spec/adapters.md § Associations are keyed by identity.
 */
function withAssociationSet(record: StackRecord, associations: Association[]): StackRecord {
  const keyed = associations.reduce<Association[]>(
    (acc, a) =>
      acc.some((b) => associationEqual(a, b))
        ? acc.map((b) => (associationEqual(a, b) ? a : b))
        : [...acc, a],
    [],
  );
  const { associations: _dropA, permissions: _dropP, ...rest } = record;
  const data = keyed.filter((a): a is DataAssociation => !isAuthority(a));
  const authority = keyed.filter(isAuthority);
  return {
    ...(rest as StackRecord),
    ...(data.length && { associations: data }),
    ...(authority.length && { permissions: authority }),
  };
}

/** withAssociationSet() over the data half alone — the `associations` key. */
function withAssociations(record: StackRecord, associations: DataAssociation[]): StackRecord {
  return withAssociationSet(record, [...associations, ...(record.permissions ?? [])]);
}

/** withAssociationSet() over the authority half alone — the `permissions` key. */
function withPermissions(record: StackRecord, permissions: AuthorityAssociation[]): StackRecord {
  return withAssociationSet(record, [...(record.associations ?? []), ...permissions]);
}

/**
 * Mirrors sqlite-shared's relatedTo predicate: a bare label matches every
 * target under it, and an external target with no `id` matches its whole
 * namespace.
 */
function matchesRelatedTo(
  associations: Association[] | undefined,
  filter: NonNullable<RecordFilter['relatedTo']>,
): boolean {
  return (associations ?? []).some((a) => {
    if (a.kind !== 'relationship') return false;
    if (filter.label !== undefined && a.label !== filter.label) return false;
    const want = filter.target;
    if (!want) return true;
    const got = a.target;
    if (got.scope !== want.scope) return false;
    if (want.scope === 'record' && got.scope === 'record') {
      return got.recordId === want.recordId && (got.stackUrl ?? '') === (want.stackUrl ?? '');
    }
    if (want.scope === 'entity' && got.scope === 'entity') return got.entityId === want.entityId;
    if (want.scope === 'external' && got.scope === 'external') {
      return got.ns === want.ns && (want.id === undefined || got.id === want.id);
    }
    return false;
  });
}
