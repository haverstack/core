/**
 * Collections — typed access to one type family
 * -------------------------------------------------------
 * `client.collection(handle)` returns a `Collection<C>`: every verb that
 * addresses records of the handle's family, each taking and returning the
 * handle's content type with one signature. Implemented once over the
 * public `StackClient` verbs, so `Stack` and `ScopedStack` share it and a
 * collection can do nothing its client could not.
 *
 * The collection's scope is the handle's whole family. Each record is read
 * as stored and migrated in memory to the handle's version, one at a time,
 * so a record the handle cannot represent — one stored at a newer version —
 * is reported as a misfit rather than failing the page it sits on. A
 * content write to a record at an older version commits its migration as a
 * write of its own first. See docs/spec/data-model.md § Type handles.
 */

import { StackBadRequestError, StackMigrationError, StackPermissionError } from './errors.js';
import { baseIdOf, parseTypeId } from './schema.js';
import { StoredVersionError, WRITE_EXPECTATION } from './stack/write-expectation.js';
import type { ExpectingClient, WriteExpectation } from './stack/write-expectation.js';
import type { MigrationRegistry } from './stack/migrations.js';
import type {
  CreateRecordOptions,
  DeleteRecordOptions,
  DeleteResult,
  StackClient,
} from './stack/client.js';
import type { ContentOf, ReadonlyTypeSchema, TypeHandle, UnlistedValue } from './type-handle.js';
import type {
  AssociationEdit,
  AuthorityAssociation,
  ChangeFilter,
  DataAssociation,
  IfVersionOptions,
  NativeSortField,
  RecordChange,
  RecordChangeSet,
  RecordFilter,
  RecordId,
  StackQuery,
  StackRecord,
  SubscribeOptions,
  Unsubscribe,
} from './types/index.js';

// -------------------------------------------------------
// Types
// -------------------------------------------------------

/**
 * Content `C` as a read returns it: an enum may hold a value the handle
 * does not list, since an enum can widen in place. Never flattens `C`, so
 * an app that names its content with an `interface` keeps that name.
 */
export type StoredContent<C> = C extends string
  ? string extends C
    ? C
    : C | UnlistedValue
  : C extends readonly (infer I)[]
    ? StoredContent<I>[]
    : C extends object
      ? { [K in keyof C]: StoredContent<C[K]> }
      : C;

/**
 * The `contentPatch` content `C` accepts: every field optional, and `null`
 * (removal) only on a field that is optional in `C`.
 */
export type ContentPatch<C> = {
  [K in keyof C]?: Pick<C, K> extends Required<Pick<C, K>> ? C[K] : Exclude<C[K], undefined> | null;
};

/** A record of the collection, migrated to the handle's version. */
export interface CollectionRecord<C> extends Omit<StackRecord, 'content'> {
  content: StoredContent<C>;
}

/**
 * A record in the handle's family that the handle cannot represent. Stored
 * at a version newer than the handle's, it cannot be migrated down.
 */
export type Misfit = {
  id: RecordId;
  reason: 'newer-version';
  /** Untyped, as stored. */
  record: StackRecord;
};

/**
 * A page of a collection. Misfits do not count as records, so a page can
 * hold fewer than `limit` records with a cursor still set: the results end
 * when `cursor` is `null`, not when a page comes back short.
 */
export type CollectionPage<C> = {
  records: CollectionRecord<C>[];
  misfits: Misfit[];
  cursor: string | null;
  /**
   * A content filter or sort reaches only records at the handle's version.
   * True when records at an older version match the rest of the query, so
   * the page may be missing records the filter was meant to find. See
   * docs/spec/data-model.md § Type handles.
   */
  skippedOlder: boolean;
};

/**
 * Path typing stops at this depth and accepts any suffix below it, since a
 * recursive path type otherwise exceeds the compiler's instantiation limit.
 * A typing limit, not a query limit: see docs/spec/data-model.md § Nested
 * content paths.
 */
type PathDepth = [never, 0, 1, 2, 3, 4, 5];

/**
 * Each content path of `V` reached at `P`, paired with the value a filter
 * compares there. An array is matched element-wise, so it is its element.
 */
type PathEntry<P extends string, V, D extends number> = [D] extends [never]
  ? [P | `${P}.${string}`, unknown]
  : V extends readonly (infer E)[]
    ? unknown extends E
      ? [P | `${P}.${string}`, unknown]
      : PathEntry<P, E, PathDepth[D]>
    : V extends object
      ? string extends keyof V
        ? [P, V] | [`${P}.${string}`, unknown]
        : [P, V] | FieldEntry<V, `${P}.`, PathDepth[D]>
      : [P, V];

/** `Required<C>[K]` rather than `NonNullable`, which would leak into errors. */
type FieldEntry<C, Prefix extends string, D extends number> = [D] extends [never]
  ? [`${Prefix}${string}`, unknown]
  : {
      [K in keyof C & string]-?: PathEntry<`${Prefix}${K}`, Required<C>[K], D>;
    }[keyof C & string];

/**
 * Every content path of `C`: its fields, and dotted paths through declared
 * objects and arrays. Below an `open` object or array, or six segments
 * deep, any suffix is a path.
 */
export type ContentPathOf<C> = FieldEntry<C, '', 6>[0];

/** The top-level scalar fields of `C`, the ones a content sort reaches. */
export type SortableFieldOf<C> = string extends keyof C
  ? string
  : {
      [K in keyof C & string]-?: Required<C>[K] extends string | number | boolean ? K : never;
    }[keyof C & string];

/**
 * A collection reads live records of its own family only, as stored, so
 * none of `typeId`, `baseId`, `includeDeleted` or `presentAt` is offered.
 * Content filter keys and the sort field are checked against `C`, and
 * reach only records stored at the handle's version. See
 * docs/spec/data-model.md § Type handles.
 */
export type CollectionQuery<C> = Omit<StackQuery, 'filter' | 'presentAt' | 'sort'> & {
  filter?: Omit<
    RecordFilter,
    'typeId' | 'baseId' | 'includeDeleted' | 'content' | 'contentPresent'
  > & {
    content?: { [E in FieldEntry<C, '', 6> as E[0]]?: E[1] | null };
    contentPresent?: FieldEntry<C, '', 6>[0][];
  };
  sort?:
    | { field: NativeSortField; contentField?: never; direction?: 'asc' | 'desc' }
    | {
        field?: never;
        // Spelled out rather than SortableFieldOf<C>, so an error lists the fields.
        contentField: string extends keyof C
          ? string
          : {
              [K in keyof C & string]-?: Required<C>[K] extends string | number | boolean
                ? K
                : never;
            }[keyof C & string];
        direction?: 'asc' | 'desc';
      };
};

/** The family is the collection's, so neither `typeId` nor `baseId` is a filter key. */
export type CollectionSubscribeOptions = Omit<SubscribeOptions, 'filter'> & {
  filter?: Omit<ChangeFilter, 'typeId' | 'baseId'>;
};

/**
 * A change to a record of the family. `record`, when present, is migrated
 * to the handle's version; `typeId` stays the stored one. A change whose
 * record does not fit carries `misfit` instead, and one whose record is a
 * tombstone carries neither.
 */
export type CollectionChange<C> = Omit<RecordChange, 'record'> & {
  record?: CollectionRecord<C>;
  misfit?: Misfit;
};

export type CollectionChangeSet<C> = Omit<RecordChangeSet, 'contentPatch'> & {
  contentPatch?: ContentPatch<C>;
};

/**
 * Typed access to one type family. History (`getVersions`, `getVersion`,
 * `getJournal`) spans versions by nature and stays on `StackClient`. See
 * docs/spec/data-model.md § Type handles.
 */
export interface Collection<C> {
  /** `null` for a missing record, a tombstone, or a record of another family. */
  get(id: RecordId): Promise<CollectionRecord<C> | null>;
  query(query?: CollectionQuery<C>): Promise<CollectionPage<C>>;
  subscribe(
    handler: (change: CollectionChange<C>) => void,
    opts?: CollectionSubscribeOptions,
  ): Promise<Unsubscribe>;
  create(content: C, opts?: CreateRecordOptions): Promise<CollectionRecord<C>>;
  mutate(
    id: RecordId,
    changes: CollectionChangeSet<C>,
    opts?: IfVersionOptions,
  ): Promise<CollectionRecord<C>>;
  patchContent(
    id: RecordId,
    patch: ContentPatch<C>,
    opts?: IfVersionOptions,
  ): Promise<CollectionRecord<C>>;
  associate(id: RecordId, associations: DataAssociation[]): Promise<CollectionRecord<C>>;
  dissociate(id: RecordId, associations: DataAssociation[]): Promise<CollectionRecord<C>>;
  amendAssociations(id: RecordId, changes: AssociationEdit[]): Promise<CollectionRecord<C>>;
  grantAccess(id: RecordId, permissions: AuthorityAssociation[]): Promise<CollectionRecord<C>>;
  revokeAccess(id: RecordId, permissions: AuthorityAssociation[]): Promise<CollectionRecord<C>>;
  amendAccess(id: RecordId, changes: AssociationEdit[]): Promise<CollectionRecord<C>>;
  delete(id: RecordId, opts?: DeleteRecordOptions): Promise<DeleteResult>;
  undelete(id: RecordId, opts?: IfVersionOptions): Promise<CollectionRecord<C>>;
  restoreVersion(
    id: RecordId,
    version: number,
    opts?: IfVersionOptions,
  ): Promise<CollectionRecord<C>>;
}

/**
 * A record the collection asked for does not fit the handle. Raised only
 * in the app's own process and never on the wire, so it sits outside the
 * `StackError` taxonomy. A write that raises it after writing says so.
 * See docs/spec/wire-format.md § The taxonomy root.
 */
export class MisfitError extends Error {
  readonly reason: Misfit['reason'];
  readonly record: StackRecord;

  constructor(misfit: Misfit, handle: TypeHandle, written = false) {
    super(
      `Record "${misfit.id}" is stored at ${misfit.record.typeId}, newer than ${handle.id}` +
        (written ? '; the write landed.' : '.'),
    );
    this.name = 'MisfitError';
    this.reason = misfit.reason;
    this.record = misfit.record;
  }
}

// -------------------------------------------------------
// Implementation
// -------------------------------------------------------

const versionOf = (typeId: string): number => parseTypeId(typeId)!.version;

/**
 * A filter's `typeId` would narrow the family to one version, so an untyped
 * caller passing one has it dropped rather than honoured.
 */
const withoutTypeId = <F extends object>(filter: F | undefined): Omit<F, 'typeId'> => {
  const { typeId: _typeId, ...rest } = (filter ?? {}) as F & { typeId?: unknown };
  return rest;
};

/**
 * Whether a query reads content, which only records stored at the handle's
 * version are guaranteed to hold in the handle's shape.
 */
const readsContent = (filter: RecordFilter | undefined, sort: StackQuery['sort']): boolean =>
  (filter?.content !== undefined && Object.keys(filter.content).length > 0) ||
  (filter?.contentPresent?.length ?? 0) > 0 ||
  sort?.contentField !== undefined;

/**
 * The collection over `handle`, shared by `Stack.collection()` and
 * `ScopedStack.collection()`. `registry` is the opening `Stack`'s, which
 * the app's own process filled.
 */
export const createCollection = <S extends ReadonlyTypeSchema>(
  client: StackClient,
  registry: MigrationRegistry,
  handle: TypeHandle<S>,
): Collection<ContentOf<S>> => {
  type C = ContentOf<S>;
  if (handle.migratesFrom !== undefined && !registry.path(handle.migratesFrom, handle.id)) {
    throw new StackMigrationError(
      `No migration from "${handle.migratesFrom}" to "${handle.id}" was passed to Stack.open().`,
    );
  }

  const writer = client as ExpectingClient;
  const family = { baseId: handle.baseId };
  const expect = (expectation: WriteExpectation = family) => ({
    [WRITE_EXPECTATION]: expectation,
  });
  const handleVersion = versionOf(handle.id);

  /**
   * One record of the family, migrated to the handle's version, or the
   * misfit it is. An older record with no migration to bridge the gap is
   * the app's setup, not the record's, and throws.
   */
  const classify = (record: StackRecord): { record: CollectionRecord<C> } | { misfit: Misfit } => {
    if (record.typeId === handle.id) return { record: record as CollectionRecord<C> };
    if (versionOf(record.typeId) > handleVersion) {
      return { misfit: { id: record.id, reason: 'newer-version', record } };
    }
    const migrate = registry.path(record.typeId, handle.id);
    if (!migrate) {
      throw new StackMigrationError(
        `Record "${record.id}" is at "${record.typeId}", and no migration passed to ` +
          `Stack.open() carries it to "${handle.id}".`,
      );
    }
    const content = migrate(record.content);
    return { record: { ...record, typeId: handle.id, content } as CollectionRecord<C> };
  };

  /** A record a write returned, narrowed as `get()` narrows it. */
  const narrow = (record: StackRecord, written: boolean): CollectionRecord<C> => {
    const result = classify(record);
    if ('misfit' in result) throw new MisfitError(result.misfit, handle, written);
    return result.record;
  };

  /**
   * A content write to a record stored at an older version: commit its
   * migration as a write of its own, fenced to the state the caller read,
   * then apply the write fenced to the version the migration produced. A
   * patch never folds a migration in. See docs/spec/data-model.md § Type
   * migrations.
   */
  const migrateThenMutate = async (
    stored: StackRecord,
    changes: RecordChangeSet,
    opts: IfVersionOptions,
  ): Promise<CollectionRecord<C>> => {
    const migrated = classify(stored);
    if ('misfit' in migrated) throw new MisfitError(migrated.misfit, handle);
    let committed: StackRecord;
    try {
      committed = await client.commitMigration(
        stored.id,
        handle.id,
        migrated.record.content as Record<string, unknown>,
        {
          ifVersion: stored.version,
        },
      );
    } catch (err) {
      if (!(err instanceof StackPermissionError)) throw err;
      throw new StackPermissionError(
        `Record "${stored.id}" is stored at ${stored.typeId} and must be migrated to ` +
          `${handle.id} before this write: ${err.message}`,
      );
    }
    const written = await writer.mutate(stored.id, changes, {
      ...opts,
      ifVersion: committed.version,
      ...expect({ ...family, typeId: handle.id }),
    });
    return narrow(written, true);
  };

  /**
   * Whether a record stored at an older version matches `filter` without
   * its content keys. A scoped page can be empty with a cursor set, so this
   * reads on until it finds one or the results end.
   */
  const hasOlder = async (filter: RecordFilter): Promise<boolean> => {
    if (handleVersion === 1) return false;
    const { content: _content, contentPresent: _present, ...rest } = filter;
    const older = Array.from({ length: handleVersion - 1 }, (_, i) => `${handle.baseId}@${i + 1}`);
    let cursor: string | undefined;
    do {
      const page = await client.query({
        filter: { ...rest, typeId: older },
        limit: 1,
        ...(cursor && { cursor }),
      });
      if (page.records.length > 0) return true;
      cursor = page.cursor ?? undefined;
    } while (cursor);
    return false;
  };

  const mutate = async (
    id: RecordId,
    changes: RecordChangeSet,
    opts: IfVersionOptions = {},
  ): Promise<CollectionRecord<C>> => {
    try {
      const written = await writer.mutate(id, changes, {
        ...opts,
        ...expect({ ...family, typeId: handle.id }),
      });
      return narrow(written, true);
    } catch (err) {
      if (!(err instanceof StoredVersionError)) throw err;
      return migrateThenMutate(err.record, changes, opts);
    }
  };

  return {
    async get(id) {
      const record = await client.get(id);
      if (!record || baseIdOf(record.typeId) !== handle.baseId) return null;
      return narrow(record, false);
    },

    async query(query = {}) {
      if ((query.filter as RecordFilter | undefined)?.includeDeleted) {
        throw new StackBadRequestError(
          'A collection reads live records only; use the untyped query() to include soft-deleted records.',
        );
      }
      // Stripped as well as untyped: either would change which records a
      // page holds, or the shape they arrive in.
      const { presentAt: _presentAt, filter, ...rest } = query as StackQuery;
      const narrowed = readsContent(filter, rest.sort);
      const familyFilter = { ...withoutTypeId(filter), baseId: handle.baseId };
      const { records, cursor } = await client.query({
        ...rest,
        filter: narrowed ? { ...familyFilter, typeId: handle.id } : familyFilter,
      });
      const page: CollectionPage<C> = {
        records: [],
        misfits: [],
        cursor,
        skippedOlder: narrowed && (await hasOlder(familyFilter)),
      };
      for (const stored of records) {
        const result = classify(stored);
        if ('misfit' in result) page.misfits.push(result.misfit);
        else page.records.push(result.record);
      }
      return page;
    },

    subscribe(handler, opts = {}) {
      return client.subscribe(
        (change) => {
          const { record, ...rest } = change;
          // A tombstone's content is `{}` under ScopedStack, so it is never
          // typed as the handle's content on either surface. A record that
          // migrated out of the family matches by its previous typeId.
          if (!record || record.deletedAt || baseIdOf(record.typeId) !== handle.baseId) {
            return handler(rest);
          }
          let result: ReturnType<typeof classify>;
          try {
            result = classify(record);
          } catch {
            // A missing or failing migration: delivered as wherever the
            // emitter cannot supply the record, and get() says why.
            return handler(rest);
          }
          handler({ ...rest, ...result });
        },
        { ...opts, filter: { ...withoutTypeId(opts.filter), baseId: handle.baseId } },
      );
    },

    async create(content, opts) {
      return (await client.create(handle.id, content, opts)) as CollectionRecord<C>;
    },

    mutate: (id, changes, opts) => mutate(id, changes as RecordChangeSet, opts),

    patchContent: (id, patch, opts) =>
      mutate(id, { contentPatch: patch as Record<string, unknown> }, opts),

    async associate(id, associations) {
      return narrow(await writer.associate(id, associations, expect()), true);
    },
    async dissociate(id, associations) {
      return narrow(await writer.dissociate(id, associations, expect()), true);
    },
    async amendAssociations(id, changes) {
      return narrow(await writer.amendAssociations(id, changes, expect()), true);
    },
    async grantAccess(id, permissions) {
      return narrow(await writer.grantAccess(id, permissions, expect()), true);
    },
    async revokeAccess(id, permissions) {
      return narrow(await writer.revokeAccess(id, permissions, expect()), true);
    },
    async amendAccess(id, changes) {
      return narrow(await writer.amendAccess(id, changes, expect()), true);
    },
    delete: (id, opts) => writer.delete(id, { ...opts, ...expect() }),
    async undelete(id, opts) {
      return narrow(await writer.undelete(id, { ...opts, ...expect() }), true);
    },
    async restoreVersion(id, version, opts) {
      return narrow(await writer.restoreVersion(id, version, { ...opts, ...expect() }), true);
    },
  };
};
