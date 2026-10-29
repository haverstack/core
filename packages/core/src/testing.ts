/**
 * @haverstack/core/testing
 * -------------------------------------------------------
 * In-memory adapters for tests: MemoryAdapter, which implements the whole
 * StackAdapter contract — every filter, sort and capability a local
 * adapter must declare — so code under test runs against real predicates;
 * and IncapableMemoryAdapter, which declares none of the optional ones, for
 * exercising the capability-gated fallbacks. Audience: tests in this repo
 * and in apps built on it.
 */

import type {
  StackAdapter,
  StackRecord,
  StackType,
  TypeId,
  RecordVersion,
  RecordJournalEntry,
  JournalEntryInput,
  JournalOptions,
  MutateOptions,
  JournalQuery,
  VersionsQuery,
  AspectWriteOptions,
  ElementWriteOptions,
  ActorOptions,
  AdapterQuery,
  AdapterSort,
  QueryResult,
  RecordFilter,
  Association,
  AssociationEdit,
  AuthorityAssociation,
  DataAssociation,
  StackCapabilities,
  BlobInfo,
  Reach,
  RecordHistory,
  StoreSeed,
} from './types/index.js';
import { SYSTEM_TYPES } from './types/index.js';
import { applyMergePatch } from './merge.js';
import { baseIdOf, fileRefFields } from './schema.js';
import { compareSortEntries, constantSortEntry, contentSortEntry } from './adapter/sort.js';
import type { SortEntry } from './adapter/sort.js';
import { inReach } from './adapter/reach.js';
import { identityOf, newStoreSeed } from './adapter/seed.js';

import {
  ElementSetMovedError,
  softDeletedRefusal,
  StackVersionConflictError,
  StackConflictError,
  StackNotFoundError,
  StackBadRequestError,
} from './errors.js';
import { matchesContent } from './content-match.js';
import { applyAssociationEdits, sameAssociationSet } from './associations/identity.js';

/** A FileId is the SHA-256 hex digest of its bytes — see docs/spec/attachments.md. */
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

// An `undefined` field is a field the record does not have; storing the key
// would make `'u' in content` differ from adapters that serialize to JSON.
const withoutUndefined = (content: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(content).filter(([, v]) => v !== undefined));

/** A fresh store's identity, or the seed a copy creates it from — never both. */
export type MemoryAdapterOpenOptions =
  | { ownerEntityId: string; timezone?: string; seed?: never }
  | { seed: StoreSeed; ownerEntityId?: never; timezone?: never };

/**
 * In-memory StackAdapter with keyed cursor pagination. Implements
 * the full RecordFilter shape (mirroring sqlite-shared's recordConditions)
 * so permission logic under test exercises real predicates. Declares
 * `filter.content: 'path'`, as every local adapter must; tests needing
 * the capability-gated paths use IncapableMemoryAdapter below.
 */
export class MemoryAdapter implements StackAdapter {
  readonly capabilities: StackCapabilities = {
    filter: {
      content: 'path',
      contentPresent: true,
      contentByType: true,
      search: false,
    },
    sort: {
      fields: ['createdAt', 'updatedAt', 'version'],
      contentField: true,
      contentFieldByType: true,
    },
    limits: {
      attachmentBytes: null,
      contentBytes: null,
    },
  };

  readonly ownerEntityId: string;

  readonly records = new Map<string, StackRecord>();
  readonly order: string[] = [];
  readonly versions = new Map<string, RecordVersion[]>();
  readonly journals = new Map<string, RecordJournalEntry[]>();
  readonly types = new Map<string, StackType>();
  readonly blobs = new Map<string, { data: Uint8Array; modifiedAt: Date }>();

  // Protected only so IncapableMemoryAdapter can extend; callers go through open().
  protected constructor(opts: MemoryAdapterOpenOptions) {
    const seed =
      opts.seed ?? newStoreSeed({ ownerEntityId: opts.ownerEntityId, timezone: opts.timezone });
    ({ ownerEntityId: this.ownerEntityId } = identityOf(seed));
    this.writeImported(seed.config, seed.history);
  }

  /**
   * Always a new store, holding only the `_config` record its seed carries;
   * `ownerEntityId` or `seed` is required so the mistake fails at compile time.
   */
  static async open(opts: MemoryAdapterOpenOptions): Promise<MemoryAdapter> {
    return new MemoryAdapter(opts);
  }

  async createRecord(record: StackRecord, opts: JournalOptions = {}) {
    if (this.records.has(record.id)) {
      throw new StackConflictError(`Record already exists: "${record.id}"`);
    }
    const stored = { ...record, content: withoutUndefined(record.content) };
    this.records.set(record.id, stored);
    this.order.push(record.id);
    this.appendJournal(record.id, opts.journal, stored);
    return stored;
  }

  async importRecord(record: StackRecord, history: RecordHistory) {
    return this.writeImported(record, history);
  }

  /** importRecord()'s write, synchronous so the constructor writes a seed the same way. */
  private writeImported(record: StackRecord, history: RecordHistory): StackRecord {
    if (this.records.has(record.id)) {
      throw new StackConflictError(`Record already exists: "${record.id}"`);
    }
    const stored = { ...record, content: withoutUndefined(record.content) };
    this.records.set(record.id, stored);
    this.order.push(record.id);
    // Held oldest first, as the writes leave them, whatever order they came in.
    this.versions.set(
      record.id,
      [...history.versions].sort((a, b) => a.version - b.version),
    );
    this.journals.set(
      record.id,
      [...history.journal].sort((a, b) => a.seq - b.seq),
    );
    return stored;
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
  private bump(record: StackRecord, { actor }: ActorOptions = {}): StackRecord {
    const { updatedBy: _by, ...rest } = record;
    return {
      ...rest,
      version: record.version + 1,
      updatedAt: new Date(),
      ...(actor && { updatedBy: actor }),
    };
  }

  /** Opt-in CAS check mirroring the real adapters' ifVersion contract. */
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
   * referencesFileId matching. Mirrors sqlite-shared's content_index,
   * computed on the fly since MemoryAdapter has no persisted index.
   */
  private hasFileRefTo(record: StackRecord, fileId: string): boolean {
    const schema = this.types.get(record.typeId)?.schema;
    if (!schema) return false;
    const content = record.content as Record<string, unknown>;
    return fileRefFields(schema).some((field) => content[field] === fileId);
  }

  async patchContent(id: string, patch: Record<string, unknown | null>, opts: MutateOptions = {}) {
    const existing = this.requireForWrite(id, opts.ifVersion);
    if (opts.snapshot) this.snapshotBeforeMutation(id, opts.snapshot);
    const content = withoutUndefined(applyMergePatch(existing.content, patch));
    return this.store(id, this.bump({ ...existing, content }, opts), opts.journal);
  }

  /** The record a write addresses, past its `ifVersion` check. */
  private requireForWrite(id: string, ifVersion: number | undefined): StackRecord {
    const existing = this.records.get(id);
    if (!existing) throw new StackNotFoundError(`Record not found: "${id}"`);
    this.checkExpectedVersion(existing, ifVersion);
    return existing;
  }

  /** requireForWrite() for an aspect write, which refuses a tombstone first. */
  private requireLiveForWrite(id: string, ifVersion: number | undefined): StackRecord {
    const existing = this.records.get(id);
    if (existing?.deletedAt) throw softDeletedRefusal(id);
    return this.requireForWrite(id, ifVersion);
  }

  private store(id: string, record: StackRecord, journal: JournalEntryInput | undefined) {
    this.records.set(id, record);
    this.appendJournal(id, journal, record);
    return record;
  }

  // An optional native field is destructured out and re-added only when
  // set: assigning `undefined` would leave the key present, which is how a
  // record grows a `parentId: undefined` every `in` check reads as a container.

  async setParent(id: string, parentId: string | null, opts: AspectWriteOptions = {}) {
    const { parentId: _p, ...rest } = this.requireLiveForWrite(id, opts.ifVersion);
    return this.store(id, { ...rest, ...(parentId !== null && { parentId }) }, opts.journal);
  }

  async setUnlisted(id: string, unlisted: boolean, opts: AspectWriteOptions = {}) {
    const { unlistedAt: _u, ...rest } = this.requireLiveForWrite(id, opts.ifVersion);
    return this.store(id, { ...rest, ...(unlisted && { unlistedAt: new Date() }) }, opts.journal);
  }

  async editAssociations(
    id: string,
    edits: AssociationEdit[],
    opts: ElementWriteOptions<DataAssociation> = {},
  ) {
    const existing = this.requireSetForWrite(id, 'associations', opts);
    const next = applyAssociationEdits(existing.associations ?? [], edits);
    return this.store(id, withHalf(existing, 'associations', next), opts.journal);
  }

  async setAssociations(
    id: string,
    associations: DataAssociation[],
    opts: ElementWriteOptions<DataAssociation> = {},
  ) {
    const existing = this.requireSetForWrite(id, 'associations', opts);
    return this.store(id, withHalf(existing, 'associations', associations), opts.journal);
  }

  async editAccess(
    id: string,
    edits: AssociationEdit[],
    opts: ElementWriteOptions<AuthorityAssociation> = {},
  ) {
    const existing = this.requireSetForWrite(id, 'permissions', opts);
    const next = applyAssociationEdits(existing.permissions ?? [], edits);
    return this.store(id, withHalf(existing, 'permissions', next), opts.journal);
  }

  async setAccess(
    id: string,
    permissions: AuthorityAssociation[],
    opts: ElementWriteOptions<AuthorityAssociation> = {},
  ) {
    const existing = this.requireSetForWrite(id, 'permissions', opts);
    return this.store(id, withHalf(existing, 'permissions', permissions), opts.journal);
  }

  /** requireLiveForWrite(), past the `expectSet` check on the half it writes too. */
  private requireSetForWrite(
    id: string,
    half: 'associations' | 'permissions',
    opts: ElementWriteOptions<Association>,
  ): StackRecord {
    const existing = this.requireLiveForWrite(id, opts.ifVersion);
    if (opts.expectSet && !sameAssociationSet(existing[half] ?? [], opts.expectSet)) {
      throw new ElementSetMovedError(id);
    }
    return existing;
  }

  async deleteRecord(id: string, opts: { purge?: boolean } & MutateOptions = {}) {
    const record = this.records.get(id);
    if (!record) {
      // A purge with nothing to fence is the one case the SQL
      // adapters answer silently; every other shape of this call reports a
      // record that isn't there, and a fixture that shrugged instead would
      // pass tests the real adapters fail.
      if (opts.purge && opts.ifVersion === undefined) return null;
      throw new StackNotFoundError(`Record not found: "${id}"`);
    }
    this.checkExpectedVersion(record, opts.ifVersion);
    if (opts.purge) {
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

  async undeleteRecord(id: string, opts: MutateOptions = {}) {
    const record = this.records.get(id);
    if (!record) throw new StackNotFoundError(`Record not found: "${id}"`);
    this.checkExpectedVersion(record, opts.ifVersion);
    if (opts.snapshot) this.snapshotBeforeMutation(id, opts.snapshot);
    const { deletedAt: _deletedAt, ...rest } = record;
    const updated = this.bump(rest as StackRecord, opts);
    this.records.set(id, updated);
    this.appendJournal(id, opts.journal, updated);
    return updated;
  }

  /** The cursor names the last record a page held, by its place in the order. */
  async queryRecords(query: AdapterQuery): Promise<QueryResult> {
    return this.select(query);
  }

  async queryReadable(query: AdapterQuery, reach: Reach): Promise<QueryResult> {
    return this.select(query, reach);
  }

  private select(query: AdapterQuery, reach?: Reach): QueryResult {
    const f = query.filter ?? {};
    let results = this.order.map((id) => this.records.get(id)!);
    if (reach) results = results.filter((r) => inReach(r, reach));
    // _config is addressable only by ID (getRecord), never returned by a
    // generic query — mirroring the real SQL adapters' WHERE exclusion.
    results = results.filter((r) => r.id !== SYSTEM_TYPES.CONFIG);
    if (!f.includeDeleted) results = results.filter((r) => !r.deletedAt);
    if (!f.includeUnlisted) results = results.filter((r) => !r.unlistedAt);
    if (f.typeId) {
      const ids = Array.isArray(f.typeId) ? f.typeId : [f.typeId];
      results = results.filter((r) => ids.includes(r.typeId));
    }
    if (f.baseId) {
      const families = Array.isArray(f.baseId) ? f.baseId : [f.baseId];
      results = results.filter((r) => families.includes(baseIdOf(r.typeId)));
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
    for (const field of ['subjectId', 'principalId'] as const) {
      const wanted = f.createdBy?.[field];
      if (wanted === undefined) continue;
      const ids = Array.isArray(wanted) ? wanted : [wanted];
      results = results.filter((r) => {
        const id = r.createdBy?.[field];
        return id !== undefined && ids.includes(id);
      });
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
    if (f.attachment) {
      const { label, fileId } = f.attachment;
      results = results.filter((r) =>
        (r.associations ?? []).some(
          (a) =>
            a.kind === 'attachment' &&
            (label === undefined || a.label === label) &&
            (fileId === undefined || a.fileId === fileId),
        ),
      );
    }
    if (f.referencesFileId) {
      const fileId = f.referencesFileId;
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
    if (f.content || f.contentPresent?.length) {
      results = results.filter((r) => matchesContent(r.content as Record<string, unknown>, f));
    }
    if (f.contentByType) {
      const arms = f.contentByType;
      results = results.filter(
        (r) =>
          Object.hasOwn(arms, r.typeId) &&
          matchesContent(r.content as Record<string, unknown>, arms[r.typeId]),
      );
    }

    results = this.sortRecords(results, query.sort);

    const { limit } = query;
    // Resume after the record the cursor names, wherever it now falls: a
    // change between pages moves no boundary, as with the real adapters'
    // keyed cursors.
    const after = query.cursor ? this.decodeCursor(query.cursor, query.sort) : null;
    const resume = after
      ? results.findIndex(
          (r) => this.compareKeys(this.orderKey(r, query.sort), after, query.sort) > 0,
        )
      : 0;
    const start = resume === -1 ? results.length : resume;
    const page = results.slice(start, start + limit);
    const last = page[page.length - 1];
    const cursor =
      last && start + limit < results.length
        ? this.encodeCursor(query.sort, this.orderKey(last, query.sort))
        : null;

    return { records: page, cursor };
  }

  /** The sort a cursor was minted under, as an opaque comparable descriptor. */
  private sortDescriptor(sort: AdapterSort): string {
    const content = sort.contentField ?? sort.contentFieldByType;
    return JSON.stringify([content ?? null, sort.field ?? null, sort.direction]);
  }

  /**
   * The last record's place in the order, paired with the sort it was
   * minted under — mirroring the real adapters' keyed cursors.
   * See docs/spec/data-model.md § Sorting and pagination.
   */
  private encodeCursor(sort: AdapterSort, key: OrderKey): string {
    const json = JSON.stringify({ d: this.sortDescriptor(sort), k: key });
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
   * Throws StackBadRequestError for a cursor that doesn't decode at all, or one
   * minted under a different sort than `sort` names — the same refusal a
   * cursor replayed under a changed sort gets from the real adapters,
   * rather than silently paging through the wrong order.
   */
  private decodeCursor(cursor: string, sort: AdapterSort): OrderKey {
    let parsed: unknown;
    try {
      const binary = atob(cursor);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      parsed = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      throw new StackBadRequestError(`Malformed cursor: "${cursor}"`);
    }
    const { d, k } = (parsed ?? {}) as { d?: unknown; k?: unknown };
    // Cursors arrive from the wire uninspected (wire/request.ts copies
    // `?cursor=` verbatim), so this is the only place the key is checked.
    if (typeof d !== 'string') throw new StackBadRequestError(`Malformed cursor: "${cursor}"`);
    // The sort first: a key is only well-formed or not for the order it names.
    if (d !== this.sortDescriptor(sort)) {
      throw new StackBadRequestError(
        `Cursor was minted under a different sort than this query names.`,
      );
    }
    const native = sort?.contentField === undefined && sort?.contentFieldByType === undefined;
    if (!isOrderKey(k, native)) throw new StackBadRequestError(`Malformed cursor: "${cursor}"`);
    return k;
  }

  /**
   * Order a result set the way a materialized sort index does: absent
   * values last in both directions, numbers before text, and `id` as the
   * final tiebreak so a page boundary falls in the same place twice.
   * The comparison itself is core's, not this double's
   * (docs/spec/data-model.md § Sorting by a content field).
   */
  private sortRecords(records: StackRecord[], sort: AdapterSort): StackRecord[] {
    const keys = new Map(records.map((r) => [r.id, this.orderKey(r, sort)]));
    return [...records].sort((a, b) => this.compareKeys(keys.get(a.id)!, keys.get(b.id)!, sort));
  }

  /** Where a record falls in the order `sort` names: its value there, then its id. */
  private orderKey(record: StackRecord, sort: AdapterSort): OrderKey {
    const { field } = sort;
    if (field !== undefined) {
      const value =
        field === 'version'
          ? record.version
          : (field === 'updatedAt' ? record.updatedAt : record.createdAt).getTime();
      return { value, id: record.id };
    }
    return { value: this.sortEntry(record, sort), id: record.id };
  }

  private compareKeys(a: OrderKey, b: OrderKey, sort: AdapterSort): number {
    const { direction } = sort;
    const sign = direction === 'asc' ? 1 : -1;
    const byValue =
      typeof a.value === 'number' && typeof b.value === 'number'
        ? sign * (a.value - b.value)
        : compareSortEntries(a.value as SortEntry | null, b.value as SortEntry | null, direction);
    return byValue || (a.id < b.id ? -sign : a.id > b.id ? sign : 0);
  }

  /**
   * The record's ordered value at `field`, or null when it holds none.
   * Read through the declared schema — a field only orders as the kind
   * its type says it is, and an undeclared or non-scalar field orders as
   * nothing at all.
   */
  private sortEntry(record: StackRecord, sort: AdapterSort): SortEntry | null {
    let field = sort.contentField;
    if (sort.contentFieldByType) {
      const key = Object.hasOwn(sort.contentFieldByType, record.typeId)
        ? sort.contentFieldByType[record.typeId]
        : { value: null };
      if (key.field === undefined) return constantSortEntry(key.value ?? null);
      field = key.field;
    }
    if (field === undefined) return null;
    const def = this.types.get(record.typeId)?.schema[field];
    if (!def || def.kind === 'array' || def.kind === 'object') return null;
    return contentSortEntry(def.kind, (record.content as Record<string, unknown>)[field]);
  }

  async getVersions(id: string, query: VersionsQuery = {}) {
    const newestFirst = [...(this.versions.get(id) ?? [])].sort((a, b) => b.version - a.version);
    const before =
      query.beforeVersion === undefined
        ? newestFirst
        : newestFirst.filter((v) => v.version < query.beforeVersion!);
    return query.limit === undefined ? before : before.slice(0, query.limit);
  }
  async getVersion(id: string, version: number) {
    return (this.versions.get(id) ?? []).find((v) => v.version === version) ?? null;
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

  async restoreVersion(id: string, version: number, opts: MutateOptions = {}) {
    const record = this.records.get(id);
    if (!record) throw new StackNotFoundError(`Record not found: "${id}"`);
    this.checkExpectedVersion(record, opts.ifVersion);
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
    opts: MutateOptions = {},
  ) {
    const record = this.records.get(id);
    if (!record) throw new StackNotFoundError(`Record not found: "${id}"`);
    this.checkExpectedVersion(record, opts.ifVersion);
    if (opts.snapshot) this.snapshotBeforeMutation(id, opts.snapshot);
    const updated = this.bump(
      { ...record, typeId: toTypeId, content: withoutUndefined(content) },
      opts,
    );
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
      // From the log's maximum, as every adapter allocates it.
      // See docs/spec/journal.md § Ordering.
      seq: (log.at(-1)?.seq ?? 0) + 1,
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
    const after = query.afterSeq === undefined ? log : log.filter((e) => e.seq > query.afterSeq!);
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
  async putBlob(data: Uint8Array): Promise<string> {
    const hashBuffer = await crypto.subtle.digest('SHA-256', data as BufferSource);
    const fileId = Array.from(new Uint8Array(hashBuffer))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    if (!this.blobs.has(fileId)) {
      this.blobs.set(fileId, { data: new Uint8Array(data), modifiedAt: new Date() });
    }
    return fileId;
  }
  async getBlob(fileId: string): Promise<Uint8Array> {
    if (!SHA256_HEX_RE.test(fileId)) {
      throw new StackBadRequestError(`Invalid fileId: expected 64-character lowercase hex string`);
    }
    const blob = this.blobs.get(fileId);
    if (!blob) throw new StackNotFoundError(`Attachment not found: "${fileId}"`);
    return new Uint8Array(blob.data);
  }
  async deleteBlob(fileId: string) {
    this.blobs.delete(fileId);
  }
  // Declared as an optional field (not a fixed method) so a test subclass
  // can override it to `undefined`, simulating an adapter that doesn't
  // implement this capability (see stack.test.ts's NoListBlobsAdapter).
  listBlobs?: () => Promise<BlobInfo[]> = async () => {
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
  override readonly capabilities: StackCapabilities = {
    filter: {
      content: 'none',
      contentPresent: false,
      contentByType: false,
      search: false,
    },
    sort: {
      fields: ['createdAt', 'updatedAt', 'version'],
      contentField: false,
      contentFieldByType: false,
    },
    limits: {
      attachmentBytes: null,
      contentBytes: null,
    },
  };

  static override async open(opts: MemoryAdapterOpenOptions): Promise<IncapableMemoryAdapter> {
    return new IncapableMemoryAdapter(opts);
  }
}

/** A record's place in an order: a native column's value, or a content sort's entry. */
type OrderKey = { value: number | SortEntry | null; id: string };

/** Whether `k` is a key of the order a native (`native`) or content sort names. */
function isOrderKey(k: unknown, native: boolean): k is OrderKey {
  if (!k || typeof k !== 'object') return false;
  const { value, id } = k as { value?: unknown; id?: unknown };
  if (typeof id !== 'string') return false;
  if (native) return typeof value === 'number' && Number.isFinite(value);
  if (value === null) return true;
  const e = value as Partial<{ kind: string; num: unknown; text: unknown; key: unknown }>;
  return (
    (e?.kind === 'num' && typeof e.num === 'number') ||
    (e?.kind === 'text' && typeof e.text === 'string' && typeof e.key === 'string')
  );
}

/** One aspect's set replaced; an empty set is omitted, as the SQL adapters' rowToRecord does. */
function withHalf(
  record: StackRecord,
  half: 'associations' | 'permissions',
  elements: Association[],
): StackRecord {
  const { [half]: _dropped, ...rest } = record;
  return { ...(rest as StackRecord), ...(elements.length && { [half]: elements }) };
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
    if (got.kind !== want.kind) return false;
    if (want.kind === 'record' && got.kind === 'record') {
      return got.recordId === want.recordId && (got.stackUrl ?? '') === (want.stackUrl ?? '');
    }
    if (want.kind === 'entity' && got.kind === 'entity') return got.entityId === want.entityId;
    if (want.kind === 'external' && got.kind === 'external') {
      return got.ns === want.ns && (want.id === undefined || got.id === want.id);
    }
    return false;
  });
}
