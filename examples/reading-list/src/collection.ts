/**
 * Collection — prototype of CONCLUSIONS-2.md § A and § C
 * -------------------------------------------------------
 * A typed view of one Type family, built only on the public `StackClient`
 * API so it can be tried here before anything moves into core. The handle
 * is the receiver: every method takes and returns the handle's types, with
 * one signature each, and query filters and sorts are checked against the
 * schema.
 *
 * Records in the family that the handle cannot type are misfits. A query
 * reports them beside the records it can type, a subscription delivers the
 * change with the misfit, and `get()` and writes throw `MisfitError`.
 *
 * Where it differs from what core would do, it says so:
 *  - Core would migrate through the Stack's own registry. A `StackClient`
 *    doesn't expose it, so the collection takes the migrations itself.
 *  - It reads as stored and migrates per record, rather than through
 *    `presentAt: 'latest'`, which throws for a whole page when one record is
 *    newer than the instance understands.
 *  - It reads a record before a content write or a delete. Core would check
 *    the family and version against the read `Stack` already makes.
 *
 * A patch to a record stored at an older version migrates it first, as its
 * own write, when the caller may commit migrations.
 */

import { StackBadRequestError, StackMigrationError, StackPermissionError } from '@haverstack/core';
import type {
  AssociationEdit,
  AuthorityAssociation,
  ContentOf,
  CreateRecordOptions,
  DataAssociation,
  DeleteRecordOptions,
  DeleteResult,
  IfVersionOptions,
  Migration,
  NativeSortField,
  ReadonlyFieldDef,
  ReadonlyTypeSchema,
  RecordChange,
  RecordChangeSet,
  RecordFilter,
  RecordId,
  StackClient,
  StackQuery,
  StackRecord,
  SubscribeOptions,
  TypeHandle,
  Unsubscribe,
} from '@haverstack/core';

// -------------------------------------------------------
// Paths a filter may name
// -------------------------------------------------------

// Everything here is derived from the content type rather than the schema,
// so an unnamed collection type prints as the shape the app works with.

/** `Record<string, unknown>` and `unknown[]`: what an `open` node derives to. */
type IsOpen<V> = V extends readonly unknown[]
  ? unknown extends V[number]
    ? true
    : false
  : V extends object
    ? string extends keyof V
      ? true
      : false
    : false;

/** Below an `open` node any suffix is a path; a scalar has none. */
type SubPathsOf<V, Depth extends unknown[]> = Depth['length'] extends 6
  ? string
  : IsOpen<V> extends true
    ? string
    : V extends readonly (infer E)[]
      ? SubPathsOf<E, [...Depth, unknown]>
      : V extends object
        ? PathsOf<V, Depth>
        : never;

/** Typed to a depth of 6; deeper than that any suffix is accepted. */
type PathsOf<C, Depth extends unknown[]> = Depth['length'] extends 6
  ? string
  : {
      [K in keyof C & string]-?: K | Join<K, SubPathsOf<Required<C>[K], [...Depth, unknown]>>;
    }[keyof C & string];

type Join<K extends string, P> = P extends string ? `${K}.${P}` : never;

/**
 * Every path a content filter may name: top-level fields, and dotted paths
 * through declared objects and arrays. See docs/spec/data-model.md § Nested
 * content paths.
 */
export type ContentPathOf<C> = PathsOf<C, []>;

/** An array is matched element-wise, so a filter value is one element. */
type LeafValue<V> =
  IsOpen<V> extends true
    ? unknown
    : V extends readonly (infer E)[]
      ? LeafValue<E>
      : V extends object
        ? never
        : V;

type ValueBelow<V, Rest extends string, Depth extends unknown[]> =
  IsOpen<V> extends true
    ? unknown
    : V extends readonly (infer E)[]
      ? ValueBelow<E, Rest, [...Depth, unknown]>
      : V extends object
        ? ValueAt<V, Rest, Depth>
        : never;

/** Mirrors PathsOf's depth limit. */
type ValueAt<C, P extends string, Depth extends unknown[] = []> = Depth['length'] extends 6
  ? unknown
  : P extends keyof C
    ? LeafValue<Required<C>[P]>
    : P extends `${infer Head}.${infer Rest}`
      ? Head extends keyof C
        ? ValueBelow<Required<C>[Head], Rest, [...Depth, unknown]>
        : never
      : never;

/** `null` matches a path holding no value, as on the untyped filter. */
export type ContentFilterOf<C> = C extends unknown
  ? { [P in ContentPathOf<C>]?: ValueAt<C, P> | null }
  : never;

/** Only top-level scalars are sortable. See docs/spec/data-model.md § Sorting by a content field. */
export type SortableFieldOf<C> =
  CollectionSort<C> extends infer Q ? (Q extends { contentField: infer F } ? F : never) : never;

// -------------------------------------------------------
// Records, writes, queries
// -------------------------------------------------------

export type CollectionRecord<C> = Omit<StackRecord, 'content'> & { content: C };

/** `null` removes a field, so only a field the content may lack accepts it. */
export type ContentPatch<C> = {
  [K in keyof C]?: Partial<Pick<C, K>> extends Pick<C, K> ? C[K] | null : C[K];
};

export type CollectionChangeSet<C> = Omit<RecordChangeSet, 'contentPatch'> & {
  contentPatch?: ContentPatch<C>;
};

export type CollectionFilter<C> = Omit<
  RecordFilter,
  'typeId' | 'baseId' | 'includeDeleted' | 'content' | 'contentPresent'
> & {
  content?: ContentFilterOf<C>;
  contentPresent?: ContentPathOf<C>[];
};

/**
 * `contentField` spells out SortableFieldOf<C> rather than naming it, so a
 * compile error lists the field names instead of the alias.
 */
export type CollectionSort<C> =
  | { field: NativeSortField; contentField?: never; direction?: 'asc' | 'desc' }
  | {
      field?: never;
      contentField: keyof {
        [K in keyof C as Required<C>[K] extends object ? never : K]: 0;
      } &
        string;
      direction?: 'asc' | 'desc';
    };

export type CollectionQuery<C> = Omit<StackQuery, 'filter' | 'sort' | 'presentAt'> & {
  filter?: CollectionFilter<C>;
  sort?: CollectionSort<C>;
};

export type MisfitReason = 'unknown-enum' | 'newer-version';

/** A record in the handle's family that the handle cannot type. */
export type Misfit = {
  id: RecordId;
  reason: MisfitReason;
  /** As stored. */
  record: StackRecord;
  /** The fields at fault, for `unknown-enum`. */
  errors?: { path: string; message: string }[];
};

export type CollectionPage<C> = {
  records: CollectionRecord<C>[];
  /** A page can hold fewer than `limit` records; only a null cursor ends it. */
  misfits: Misfit[];
  cursor: string | null;
};

/** `record` when the handle can type it, `misfit` when it cannot. */
export type CollectionChange<C> = Omit<RecordChange, 'record'> & {
  record?: CollectionRecord<C>;
  misfit?: Misfit;
};

export type CollectionSubscribeOptions = Omit<SubscribeOptions, 'filter'> & {
  filter?: Omit<NonNullable<SubscribeOptions['filter']>, 'typeId' | 'baseId'>;
};

export class MisfitError extends Error {
  readonly misfit: Misfit;

  constructor(misfit: Misfit) {
    super(describeMisfit(misfit));
    this.name = 'MisfitError';
    this.misfit = misfit;
  }
}

const describeMisfit = (m: Misfit): string =>
  m.reason === 'newer-version'
    ? `Record "${m.id}" is stored at ${m.record.typeId}, newer than this app understands. Update the app to read it.`
    : `Record "${m.id}" holds values this app's schema does not list:\n` +
      (m.errors ?? []).map((e) => `  ${e.path}: ${e.message}`).join('\n');

// -------------------------------------------------------
// Classification
// -------------------------------------------------------

const parseTypeId = (typeId: string): { baseId: string; version: number } | null => {
  const match = typeId.match(/^(.+)@(\d+)$/);
  return match ? { baseId: match[1], version: Number(match[2]) } : null;
};

const unknownEnumValues = (
  value: unknown,
  def: ReadonlyFieldDef,
  path: string,
  out: { path: string; message: string }[],
): void => {
  if (value === undefined || value === null) return;
  if (def.kind === 'string') {
    if (def.enum && typeof value === 'string' && !def.enum.includes(value)) {
      out.push({
        path,
        message: `Expected one of ${def.enum.map((v) => JSON.stringify(v)).join(', ')}, got ${JSON.stringify(value)}`,
      });
    }
  } else if (def.kind === 'array' && !def.open && Array.isArray(value)) {
    value.forEach((item, i) => unknownEnumValues(item, def.items, `${path}[${i}]`, out));
  } else if (def.kind === 'object' && !def.open && typeof value === 'object') {
    walkEnums(value as Record<string, unknown>, def.properties, `${path}.`, out);
  }
};

const walkEnums = (
  content: Record<string, unknown>,
  schema: ReadonlyTypeSchema,
  prefix: string,
  out: { path: string; message: string }[],
): void => {
  for (const key of Object.keys(schema)) {
    unknownEnumValues(content[key], schema[key], `${prefix}${key}`, out);
  }
};

type Fit<C> =
  | { kind: 'fit'; record: CollectionRecord<C> }
  | { kind: 'misfit'; misfit: Misfit }
  | { kind: 'foreign' };

// -------------------------------------------------------
// The collection
// -------------------------------------------------------

export class Collection<C extends object> {
  readonly handle: TypeHandle;
  private readonly client: StackClient;
  private readonly version: number;
  private readonly migrations: ReadonlyMap<string, Migration>;

  constructor(
    client: StackClient,
    handle: TypeHandle,
    opts: { migrations?: readonly Migration[] } = {},
  ) {
    this.client = client;
    this.handle = handle;
    this.version = parseTypeId(handle.id)!.version;
    this.migrations = new Map((opts.migrations ?? []).map((m) => [m.from, m]));
  }

  // ----- reads -----

  /** `null` for a missing or deleted record, or one outside the family. */
  async get(id: RecordId): Promise<CollectionRecord<C> | null> {
    const record = await this.client.get(id);
    if (!record) return null;
    const fit = this.classify(record);
    if (fit.kind === 'foreign') return null;
    if (fit.kind === 'misfit') throw new MisfitError(fit.misfit);
    return fit.record;
  }

  async query(query: CollectionQuery<C> = {}): Promise<CollectionPage<C>> {
    if ((query.filter as RecordFilter | undefined)?.includeDeleted) {
      throw new StackBadRequestError(
        'A collection sees live records only; use the untyped query to include soft-deleted records.',
      );
    }
    const result = await this.client.query({
      ...query,
      filter: { ...(query.filter as RecordFilter), baseId: this.handle.baseId },
    } as StackQuery);
    const page: CollectionPage<C> = { records: [], misfits: [], cursor: result.cursor };
    for (const record of result.records) {
      const fit = this.classify(record);
      if (fit.kind === 'fit') page.records.push(fit.record);
      else if (fit.kind === 'misfit') page.misfits.push(fit.misfit);
    }
    return page;
  }

  /** The whole family, each record migrated in memory to the handle's version. */
  subscribe(
    handler: (change: CollectionChange<C>) => void,
    opts: CollectionSubscribeOptions = {},
  ): Promise<Unsubscribe> {
    return this.client.subscribe(
      (change) => {
        const { record, ...rest } = change;
        // Under ScopedStack a tombstone's content is `{}`, which fits no schema.
        if (!record || record.deletedAt) return handler(rest);
        const fit = this.classify(record);
        if (fit.kind === 'fit') handler({ ...rest, record: fit.record });
        else if (fit.kind === 'misfit') handler({ ...rest, misfit: fit.misfit });
        else handler(rest);
      },
      { ...opts, filter: { ...opts.filter, baseId: this.handle.baseId } },
    );
  }

  // ----- content writes -----

  async create(content: C, opts?: CreateRecordOptions): Promise<CollectionRecord<C>> {
    return this.written(
      await this.client.create(this.handle.id, content as Record<string, unknown>, opts),
    );
  }

  async mutate(
    id: RecordId,
    changes: CollectionChangeSet<C>,
    opts?: IfVersionOptions,
  ): Promise<CollectionRecord<C>> {
    if (changes.contentPatch) opts = await this.migrateForPatch(id, opts);
    return this.written(await this.client.mutate(id, changes, opts));
  }

  async patchContent(
    id: RecordId,
    patch: NonNullable<CollectionChangeSet<C>['contentPatch']>,
    opts?: IfVersionOptions,
  ): Promise<CollectionRecord<C>> {
    return this.mutate(id, { contentPatch: patch }, opts);
  }

  // ----- association, access and lifecycle writes -----

  async associate(id: RecordId, associations: DataAssociation[]): Promise<CollectionRecord<C>> {
    return this.written(await this.client.associate(id, associations));
  }

  async dissociate(id: RecordId, associations: DataAssociation[]): Promise<CollectionRecord<C>> {
    return this.written(await this.client.dissociate(id, associations));
  }

  async amendAssociations(id: RecordId, changes: AssociationEdit[]): Promise<CollectionRecord<C>> {
    return this.written(await this.client.amendAssociations(id, changes));
  }

  async grantAccess(
    id: RecordId,
    permissions: AuthorityAssociation[],
  ): Promise<CollectionRecord<C>> {
    return this.written(await this.client.grantAccess(id, permissions));
  }

  async revokeAccess(
    id: RecordId,
    permissions: AuthorityAssociation[],
  ): Promise<CollectionRecord<C>> {
    return this.written(await this.client.revokeAccess(id, permissions));
  }

  async amendAccess(id: RecordId, changes: AssociationEdit[]): Promise<CollectionRecord<C>> {
    return this.written(await this.client.amendAccess(id, changes));
  }

  /** Destructive and returns no record, so the family is checked first. */
  async delete(id: RecordId, opts?: DeleteRecordOptions): Promise<DeleteResult> {
    const current = await this.client.get(id, { includeDeleted: true });
    if (current && this.classify(current).kind === 'foreign') throw this.notInFamily(current);
    return this.client.delete(id, opts);
  }

  async undelete(id: RecordId, opts?: IfVersionOptions): Promise<CollectionRecord<C>> {
    return this.written(await this.client.undelete(id, opts));
  }

  /** A snapshot from an older version reads back migrated, like any record. */
  async restoreVersion(
    id: RecordId,
    version: number,
    opts?: IfVersionOptions,
  ): Promise<CollectionRecord<C>> {
    return this.written(await this.client.restoreVersion(id, version, opts));
  }

  // ----- internals -----

  private classify(record: StackRecord): Fit<C> {
    const parsed = parseTypeId(record.typeId);
    if (!parsed || parsed.baseId !== this.handle.baseId) return { kind: 'foreign' };
    if (parsed.version > this.version) {
      return { kind: 'misfit', misfit: { id: record.id, reason: 'newer-version', record } };
    }
    const content = this.migrateUp(record);
    const errors: { path: string; message: string }[] = [];
    walkEnums(content, this.handle.schema, '', errors);
    if (errors.length > 0) {
      return { kind: 'misfit', misfit: { id: record.id, reason: 'unknown-enum', record, errors } };
    }
    return {
      kind: 'fit',
      record: { ...record, typeId: this.handle.id, content } as CollectionRecord<C>,
    };
  }

  /** A gap in the chain is the app's setup, not the data, so it throws. */
  private migrateUp(record: StackRecord): Record<string, unknown> {
    let content = record.content;
    let at = record.typeId;
    while (at !== this.handle.id) {
      const step = this.migrations.get(at);
      if (!step) {
        throw new StackMigrationError(
          `No migration from "${at}" toward "${this.handle.id}" was given to this collection.`,
        );
      }
      content = step.migrate(content);
      at = step.to;
    }
    return content;
  }

  /** The record a write returned, or why the handle cannot type it. */
  private written(record: StackRecord): CollectionRecord<C> {
    const fit = this.classify(record);
    if (fit.kind === 'fit') return fit.record;
    if (fit.kind === 'misfit') throw new MisfitError(fit.misfit);
    throw this.notInFamily(record, ' The write was applied.');
  }

  /**
   * A patch is validated against the record's stored Type, and a patch never
   * migrates (docs/spec/data-model.md § Type migrations). So a record stored
   * at an older version is migrated as its own write first, and the patch is
   * fenced to the version that produced. Returns the options for the patch.
   */
  private async migrateForPatch(
    id: RecordId,
    opts: IfVersionOptions = {},
  ): Promise<IfVersionOptions> {
    const current = await this.client.get(id, { includeDeleted: true });
    // Missing, deleted or already current: mutate() refuses or applies it.
    if (!current || current.deletedAt || current.typeId === this.handle.id) return opts;
    const fit = this.classify(current);
    if (fit.kind === 'foreign') throw this.notInFamily(current);
    if (fit.kind === 'misfit' && fit.misfit.reason === 'newer-version') {
      throw new MisfitError(fit.misfit);
    }
    try {
      const migrated = await this.client.commitMigration(
        id,
        this.handle.id,
        this.migrateUp(current),
        opts,
      );
      return { ...opts, ifVersion: migrated.version };
    } catch (err) {
      if (!(err instanceof StackPermissionError)) throw err;
      throw new StackPermissionError(
        `Record "${id}" is stored at ${current.typeId}, and a patch through ${this.handle.id} ` +
          `needs it migrated first, which only the stack owner or the app's install may do.`,
      );
    }
  }

  private notInFamily(record: StackRecord, suffix = ''): StackBadRequestError {
    return new StackBadRequestError(
      `Record "${record.id}" is ${record.typeId}, not in the ${this.handle.baseId} collection.${suffix}`,
    );
  }
}

/** Typed by the handle's content, not its schema. */
export const collection = <S extends ReadonlyTypeSchema>(
  client: StackClient,
  handle: TypeHandle<S>,
  opts?: { migrations?: readonly Migration[] },
): Collection<ContentOf<S>> => new Collection(client, handle, opts);
