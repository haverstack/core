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
import {
  translateArm,
  translateSortKey,
  UNMATCHABLE,
  UNTRANSLATABLE,
} from './content-translation.js';
import type {
  AssociationEdit,
  AuthorityAssociation,
  ChangeFilter,
  ContentArm,
  ContentSortKey,
  DataAssociation,
  IfVersionOptions,
  NativeSortField,
  RecordChange,
  RecordFilter,
  RecordId,
  StackQuery,
  StackType,
  TypeId,
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
   * Set when records at a version a content filter or sort could not reach
   * match, or may match, the rest of the query. On the first page only,
   * since it depends on the query rather than the page. See
   * docs/spec/data-model.md § Content queries across versions.
   */
  skipped?: { older: boolean; newer: boolean };
};

/**
 * Path typing stops at this depth and accepts any suffix below it, since a
 * recursive path type otherwise exceeds the compiler's instantiation limit.
 * A typing limit, not a query limit: see docs/spec/data-model.md § Nested
 * content paths.
 */
type PathDepth = [never, 0, 1, 2, 3, 4];

/** What a filter value can equal: an adapter compares the value a path reaches. */
type Leaf = string | number | boolean;

/**
 * Each content path of `V` reached at `P`, paired with the value a filter
 * compares there. An array is matched element-wise, so it is its element.
 * An object never equals a filter value, so its path takes only `null`.
 */
type PathEntry<P extends string, V, D extends number> = [D] extends [never]
  ? [P | `${P}.${string}`, Leaf]
  : V extends readonly (infer E)[]
    ? unknown extends E
      ? [P | `${P}.${string}`, Leaf]
      : PathEntry<P, E, PathDepth[D]>
    : V extends object
      ? string extends keyof V
        ? [P, null] | [`${P}.${string}`, Leaf]
        : [P, null] | FieldEntry<V, `${P}.`, PathDepth[D]>
      : [P, V];

/** `Required<C>[K]` rather than `NonNullable`, which would leak into errors. */
type FieldEntry<C, Prefix extends string, D extends number> = [D] extends [never]
  ? [`${Prefix}${string}`, Leaf]
  : {
      [K in keyof C & string]-?: PathEntry<`${Prefix}${K}`, Required<C>[K], D>;
    }[keyof C & string];

/**
 * Every content path of `C`: its fields, and dotted paths through declared
 * objects and arrays. Below an `open` object or array, or six segments
 * deep, any suffix is a path.
 */
export type ContentPathOf<C> = FieldEntry<C, '', 5>[0];

/** The top-level scalar fields of `C`, the ones a content sort reaches. */
export type SortableFieldOf<C> = string extends keyof C
  ? string
  : {
      [K in keyof C & string]-?: Required<C>[K] extends string | number | boolean ? K : never;
    }[keyof C & string];

/**
 * A collection reads live records of its own family only, as stored, so
 * none of `typeId`, `baseId`, `includeDeleted`, `presentAt` or the per-Type
 * shapes it generates itself is offered. Content filter keys and the sort
 * field are checked against `C`, and carried to older versions through the
 * migrations. See docs/spec/data-model.md § Type handles.
 */
export type CollectionQuery<C> = Omit<StackQuery, 'filter' | 'presentAt' | 'sort'> & {
  filter?: Omit<
    RecordFilter,
    'typeId' | 'baseId' | 'includeDeleted' | 'content' | 'contentPresent' | 'contentByType'
  > & {
    content?: { [E in FieldEntry<C, '', 5> as E[0]]?: E[1] | null };
    contentPresent?: ContentPathOf<C>[];
  };
  sort?:
    | { field: NativeSortField; contentField?: never; direction?: 'asc' | 'desc' }
    | {
        field?: never;
        contentField: SortableFieldOf<C>;
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
  patchContent(
    id: RecordId,
    patch: ContentPatch<C>,
    opts?: IfVersionOptions,
  ): Promise<CollectionRecord<C>>;
  setParent(
    id: RecordId,
    parentId: RecordId | null,
    opts?: IfVersionOptions,
  ): Promise<CollectionRecord<C>>;
  setUnlisted(
    id: RecordId,
    unlisted: boolean,
    opts?: IfVersionOptions,
  ): Promise<CollectionRecord<C>>;
  editAssociations(
    id: RecordId,
    edits: AssociationEdit[],
    opts?: IfVersionOptions,
  ): Promise<CollectionRecord<C>>;
  setAssociations(
    id: RecordId,
    associations: DataAssociation[],
    opts?: IfVersionOptions,
  ): Promise<CollectionRecord<C>>;
  editAccess(
    id: RecordId,
    edits: AssociationEdit[],
    opts?: IfVersionOptions,
  ): Promise<CollectionRecord<C>>;
  setAccess(
    id: RecordId,
    permissions: AuthorityAssociation[],
    opts?: IfVersionOptions,
  ): Promise<CollectionRecord<C>>;
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
 * A filter's content predicate, or undefined when it names no key. Only
 * records stored at the handle's version are guaranteed to hold content in
 * the handle's shape, so a predicate is what has to be translated.
 */
const contentPredicate = (filter: RecordFilter): ContentArm | undefined => {
  const content = Object.keys(filter.content ?? {}).length > 0 ? filter.content : undefined;
  const present = filter.contentPresent?.length ? filter.contentPresent : undefined;
  if (!content && !present) return undefined;
  return { ...(content && { content }), ...(present && { contentPresent: present }) };
};

/** `filter` without its content predicate, for a query that asks about the rest. */
const withoutContent = (filter: RecordFilter): RecordFilter => {
  const { content: _content, contentPresent: _present, ...rest } = filter;
  return rest;
};

/**
 * A content query's cursor: the adapter's, with the versions the first page
 * queried, so a version defined mid-pagination cannot change the arms or
 * the sort a cursor resumes, and a later page lists no types.
 */
const encodeContentCursor = (versions: TypeId[], cursor: string): string => {
  const bytes = new TextEncoder().encode(JSON.stringify({ v: versions, c: cursor }));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

const decodeContentCursor = (
  raw: string,
  handle: TypeHandle,
): { versions: TypeId[]; cursor: string } => {
  const malformed = () => new StackBadRequestError(`Invalid cursor: malformed "${raw}"`);
  let parsed: unknown;
  try {
    const binary = atob(raw);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw malformed();
  }
  const { v, c } = (parsed ?? {}) as { v?: unknown; c?: unknown };
  if (
    typeof c !== 'string' ||
    !Array.isArray(v) ||
    !v.every((id) => typeof id === 'string' && parseTypeId(id)?.baseId === handle.baseId)
  ) {
    throw malformed();
  }
  return { versions: v as TypeId[], cursor: c };
};

/**
 * The collection over `handle`, shared by `Stack.collection()` and
 * `ScopedStack.collection()`. `registry` is the opening `Stack`'s, which
 * the app's own process filled. `listTypes` names the family's versions,
 * which `StackClient` does not offer.
 */
export const createCollection = <S extends ReadonlyTypeSchema>(
  client: StackClient,
  registry: MigrationRegistry,
  handle: TypeHandle<S>,
  listTypes: () => Promise<StackType[]>,
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
  const migrateThenPatch = async (
    stored: StackRecord,
    patch: Record<string, unknown | null>,
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
    const written = await writer.patchContent(stored.id, patch, {
      ...opts,
      ifVersion: committed.version,
      ...expect({ ...family, typeId: handle.id }),
    });
    return narrow(written, true);
  };

  /**
   * Whether any record matches, or may match, `filter`. A scoped page can
   * be empty with a cursor set, and reading on is unbounded, so that page
   * counts as a match.
   */
  const anyMatch = async (filter: RecordFilter): Promise<boolean> => {
    const page = await client.query({ filter, limit: 1 });
    return page.records.length > 0 || page.cursor !== null;
  };

  /** Whether a record stored at one of `typeIds` matches `filter` without its content keys. */
  const anyAt = async (typeIds: TypeId[], filter: RecordFilter): Promise<boolean> => {
    if (typeIds.length === 0) return false;
    return anyMatch({ ...withoutContent(filter), typeId: typeIds });
  };

  /**
   * Whether records at an older version hold what its arm left out: each
   * residual is that arm with another source value in place, at its typeId.
   */
  const anyResidual = async (residuals: RecordFilter[], filter: RecordFilter): Promise<boolean> => {
    const rest = withoutContent(filter);
    const found = await Promise.all(
      residuals.map((residual) => anyMatch({ ...rest, ...residual })),
    );
    return found.some(Boolean);
  };

  /**
   * A content query as one arm per version it translates to, plus what the
   * first page probes for `skipped`. `pinned` is the versions a first page
   * chose, which a later page reuses. See docs/spec/data-model.md § Content
   * queries across versions.
   */
  const planContentQuery = async (
    filter: RecordFilter,
    sort: StackQuery['sort'],
    pinned?: TypeId[],
  ): Promise<{
    query: Pick<StackQuery, 'filter' | 'sort'>;
    versions: TypeId[];
    narrowed: TypeId[];
    newer: TypeId[];
    residuals: RecordFilter[];
  }> => {
    const predicate = contentPredicate(filter);
    const sortField = sort?.contentField;
    const { capabilities } = client;
    // Spanning versions takes the per-Type shape of each content key the
    // query carries; an adapter without one gets the handle's version alone.
    const spans =
      (predicate === undefined || capabilities.filter.contentByType) &&
      (sortField === undefined || capabilities.sort.contentFieldByType);
    const sortKind = (() => {
      const def = sortField === undefined ? undefined : handle.schema[sortField];
      return def && def.kind !== 'array' && def.kind !== 'object' ? def.kind : undefined;
    })();

    const family = (
      pinned
        ? pinned.map((id) => ({ id, baseId: handle.baseId, version: versionOf(id) }))
        : await listTypes()
    ).filter((type) => type.baseId === handle.baseId && type.version !== handleVersion);
    const arms: Record<TypeId, ContentArm> = { [handle.id]: predicate ?? {} };
    const keys: Record<TypeId, ContentSortKey> = sortField
      ? { [handle.id]: { field: sortField } }
      : {};
    const narrowed: TypeId[] = [];
    const newer: TypeId[] = [];
    const residuals: RecordFilter[] = [];
    for (const type of family) {
      if (type.version > handleVersion) {
        newer.push(type.id);
        continue;
      }
      const origins = registry.origins(type.id, handle.id);
      const translated = !predicate
        ? { arm: {}, residuals: [] }
        : origins
          ? translateArm(origins, predicate)
          : UNTRANSLATABLE;
      if (translated === UNMATCHABLE) continue;
      const key =
        sortField === undefined
          ? undefined
          : origins
            ? translateSortKey(origins, sortField, sortKind)
            : UNTRANSLATABLE;
      if (translated === UNTRANSLATABLE || key === UNTRANSLATABLE || !spans) {
        narrowed.push(type.id);
        continue;
      }
      arms[type.id] = translated.arm;
      if (key) keys[type.id] = key;
      for (const arm of translated.residuals) residuals.push({ ...arm, typeId: type.id });
    }

    const rest = withoutContent(filter);
    const typeIds = Object.keys(arms);
    if (typeIds.length === 1) {
      return {
        query: { filter: { ...filter, typeId: handle.id }, sort },
        versions: typeIds,
        narrowed,
        newer,
        residuals,
      };
    }
    return {
      query: {
        filter: predicate ? { ...rest, contentByType: arms } : { ...rest, typeId: typeIds },
        sort: sortField
          ? { contentFieldByType: keys, ...(sort?.direction && { direction: sort.direction }) }
          : sort,
      },
      versions: typeIds,
      narrowed,
      newer,
      residuals,
    };
  };

  const patchContent = async (
    id: RecordId,
    patch: Record<string, unknown | null>,
    opts: IfVersionOptions = {},
  ): Promise<CollectionRecord<C>> => {
    try {
      const written = await writer.patchContent(id, patch, {
        ...opts,
        ...expect({ ...family, typeId: handle.id }),
      });
      return narrow(written, true);
    } catch (err) {
      if (!(err instanceof StoredVersionError)) throw err;
      return migrateThenPatch(err.record, patch, opts);
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
      // A concrete typeId needs no family lookup; baseId does.
      const {
        baseId: _baseId,
        contentByType: _byType,
        ...unversioned
      } = withoutTypeId(filter) as RecordFilter;
      const firstPage = rest.cursor === undefined;
      let records: StackRecord[];
      let cursor: string | null;
      let skipped: CollectionPage<C>['skipped'];
      if (!contentPredicate(unversioned) && rest.sort?.contentField === undefined) {
        ({ records, cursor } = await client.query({
          ...rest,
          filter: { ...unversioned, baseId: handle.baseId },
        }));
        if (firstPage) skipped = { older: false, newer: false };
      } else {
        const resumed = firstPage ? undefined : decodeContentCursor(rest.cursor!, handle);
        const plan = await planContentQuery(unversioned, rest.sort, resumed?.versions);
        const [page, narrowed, residual, newer] = await Promise.all([
          client.query({ ...rest, cursor: resumed?.cursor, ...plan.query }),
          firstPage && anyAt(plan.narrowed, unversioned),
          firstPage && anyResidual(plan.residuals, unversioned),
          firstPage && anyAt(plan.newer, unversioned),
        ]);
        records = page.records;
        cursor = page.cursor && encodeContentCursor(plan.versions, page.cursor);
        if (firstPage) skipped = { older: narrowed || residual, newer };
      }
      const page: CollectionPage<C> = {
        records: [],
        misfits: [],
        cursor,
        ...(skipped && { skipped }),
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

    patchContent: (id, patch, opts) =>
      patchContent(id, patch as Record<string, unknown | null>, opts),

    async setParent(id, parentId, opts) {
      return narrow(await writer.setParent(id, parentId, { ...opts, ...expect() }), true);
    },
    async setUnlisted(id, unlisted, opts) {
      return narrow(await writer.setUnlisted(id, unlisted, { ...opts, ...expect() }), true);
    },
    async editAssociations(id, edits, opts) {
      return narrow(await writer.editAssociations(id, edits, { ...opts, ...expect() }), true);
    },
    async setAssociations(id, associations, opts) {
      return narrow(await writer.setAssociations(id, associations, { ...opts, ...expect() }), true);
    },
    async editAccess(id, edits, opts) {
      return narrow(await writer.editAccess(id, edits, { ...opts, ...expect() }), true);
    },
    async setAccess(id, permissions, opts) {
      return narrow(await writer.setAccess(id, permissions, { ...opts, ...expect() }), true);
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
