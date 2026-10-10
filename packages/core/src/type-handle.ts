/**
 * Stack — Type handles
 * -------------------------------------------------------
 * A Type's schema written once as a literal, from which the compiler derives
 * the content type: `ContentOf` for a create, `StoredContentOf` for a read,
 * `PatchOf` for a `contentPatch`. A handle is a plain value, so `StackClient`
 * code can use it wherever it has no `defineType()` result.
 *
 * The derived types layer over runtime validation, which stays the guarantee.
 * What a typed read adds is a runtime check that the record is the handle's
 * Type. See docs/spec/data-model.md § Type handles.
 */

import { StackBadRequestError, StackMigrationError } from './errors.js';
import { lineageProblem, parseTypeId } from './schema.js';
import { StoredVersionError, WRITE_EXPECTATION } from './stack/write-expectation.js';
import type { CreateRecordOptions, StackClient } from './stack/client.js';
import type {
  BaseId,
  ChangeFilter,
  IfVersionOptions,
  RecordChange,
  RecordChangeSet,
  RecordId,
  RecordFilter,
  ScalarFieldKind,
  StackQuery,
  StackRecord,
  SubscribeOptions,
  TypeId,
  Unsubscribe,
} from './types/index.js';

// -------------------------------------------------------
// Schema literal types
// -------------------------------------------------------

/**
 * `FieldDef` with readonly members, which is what a `const` type parameter
 * infers for a literal (`values` becomes a readonly tuple). Every mutable
 * `TypeSchema` is assignable to it, so it is also what `defineType()` takes.
 */
export type ReadonlyFieldDef =
  | {
      readonly kind: 'enum';
      readonly values: readonly string[];
      readonly required?: boolean;
    }
  | { readonly kind: Exclude<ScalarFieldKind, 'enum'>; readonly required?: boolean }
  | {
      readonly kind: 'array';
      readonly items: ReadonlyFieldDef;
      readonly open?: false;
      readonly required?: boolean;
    }
  | {
      readonly kind: 'array';
      readonly open: true;
      readonly items?: undefined;
      readonly required?: boolean;
    }
  | {
      readonly kind: 'object';
      readonly properties: ReadonlyTypeSchema;
      readonly open?: false;
      readonly required?: boolean;
    }
  | {
      readonly kind: 'object';
      readonly open: true;
      readonly properties?: undefined;
      readonly required?: boolean;
    };

export type ReadonlyTypeSchema = { readonly [fieldName: string]: ReadonlyFieldDef };

// -------------------------------------------------------
// Derived types
// -------------------------------------------------------

type IsRequired<D> = D extends { readonly required: true } ? true : false;

type Simplify<T> = { [K in keyof T]: T[K] } & {};

/** What a value is read as or written as; they differ only for an enum. */
type Direction = 'read' | 'write';

/**
 * A string an enum's `values` do not list. An enum may widen in place, so a
 * read can meet one; `string & {}` keeps the listed values as completions.
 * See docs/spec/data-model.md § Type handles.
 */
export type UnlistedValue = string & {};

type ValueOf<D, M extends Direction> = D extends {
  readonly kind: 'enum';
  readonly values: readonly (infer E)[];
}
  ? M extends 'read'
    ? E | UnlistedValue
    : E
  : D extends { readonly kind: 'string' | 'text' | 'date' | 'record-ref' | 'file-ref' }
    ? string
    : D extends { readonly kind: 'number' }
      ? number
      : D extends { readonly kind: 'boolean' }
        ? boolean
        : D extends { readonly kind: 'array'; readonly open: true }
          ? unknown[]
          : D extends { readonly kind: 'array'; readonly items: infer I }
            ? ValueOf<I, M>[]
            : D extends { readonly kind: 'object'; readonly open: true }
              ? Record<string, unknown>
              : D extends { readonly kind: 'object'; readonly properties: infer P }
                ? P extends ReadonlyTypeSchema
                  ? ContentAs<P, M>
                  : never
                : never;

type ContentAs<S extends ReadonlyTypeSchema, M extends Direction> = Simplify<
  {
    -readonly [K in keyof S as IsRequired<S[K]> extends true ? K : never]: ValueOf<S[K], M>;
  } & {
    -readonly [K in keyof S as IsRequired<S[K]> extends true ? never : K]?: ValueOf<S[K], M>;
  }
>;

/**
 * The content a schema describes, as a write supplies it: a required field
 * is present, any other may be absent. See docs/spec/data-model.md § Type
 * handles.
 */
export type ContentOf<S extends ReadonlyTypeSchema> = ContentAs<S, 'write'>;

/** `ContentOf`, as a read returns it: an enum may hold an unlisted value. */
export type StoredContentOf<S extends ReadonlyTypeSchema> = ContentAs<S, 'read'>;

/**
 * The `contentPatch` a schema accepts: every field optional, and `null`
 * (removal) only on a field that is not required — a required field can be
 * replaced but not removed.
 */
export type PatchOf<S extends ReadonlyTypeSchema> = Simplify<{
  -readonly [K in keyof S]?: IsRequired<S[K]> extends true
    ? ValueOf<S[K], 'write'>
    : ValueOf<S[K], 'write'> | null;
}>;

/** A record whose content is the handle's, as a typed read returns it. */
export type TypedRecord<S extends ReadonlyTypeSchema> = Omit<StackRecord, 'content'> & {
  content: StoredContentOf<S>;
};

// -------------------------------------------------------
// The handle
// -------------------------------------------------------

/**
 * One version of one Type: what `defineType()` takes, plus the family. Plain
 * data, so a manifest can carry it as written. See docs/spec/data-model.md
 * § Type handles.
 */
export type TypeHandle<S extends ReadonlyTypeSchema = ReadonlyTypeSchema> = {
  readonly id: TypeId;
  readonly baseId: BaseId;
  readonly name: string;
  readonly schema: S;
  readonly migratesFrom?: TypeId;
};

/**
 * Name a Type, its display name, its schema and the version it migrates
 * from in one literal. Pass the result to `defineType()`, a manifest's
 * `types` and the typed overloads of `StackClient`. A handle names exactly
 * one version: `Book.baseId` is the argument a call about the whole family
 * takes.
 */
export const typeHandle = <const S extends ReadonlyTypeSchema>({
  id,
  name,
  schema,
  migratesFrom,
}: {
  id: TypeId;
  name: string;
  schema: S;
  migratesFrom?: TypeHandle | TypeId;
}): TypeHandle<S> => {
  const parsed = parseTypeId(id);
  if (!parsed) {
    throw new StackBadRequestError(
      `Invalid TypeId format: "${id}". Expected "namespace/name@version", e.g. "com.example.myapp/note@1".`,
    );
  }
  const from =
    typeof migratesFrom === 'object' && migratesFrom !== null ? migratesFrom.id : migratesFrom;
  const problem = lineageProblem(id, from);
  if (problem) throw new StackBadRequestError(problem);
  return Object.freeze({
    id,
    baseId: parsed.baseId,
    name,
    schema,
    ...(from !== undefined && { migratesFrom: from }),
  });
};

export const isTypeHandle = (value: unknown): value is TypeHandle =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as TypeHandle).id === 'string' &&
  typeof (value as TypeHandle).baseId === 'string' &&
  typeof (value as TypeHandle).schema === 'object';

// -------------------------------------------------------
// Migrations
// -------------------------------------------------------

/**
 * A step from one version of a type to another, passed to `Stack.open()`
 * and typed on both versions' content. `migrate` is a method so a typed
 * migration fits a list of untyped ones. See docs/spec/data-model.md § Type
 * migrations.
 */
export type Migration<From = Record<string, unknown>, To = Record<string, unknown>> = {
  readonly from: TypeId;
  readonly to: TypeId;
  migrate(content: From): To;
};

/**
 * Build the migration from `from` to `to`, checking `fn` against both
 * handles' stored content: a stored enum may hold a value either handle
 * does not list, and a step carries it through. Within a family, `to` must name `from` as its
 * `migratesFrom`; a step into another family has no lineage to check. See
 * docs/spec/data-model.md § Type migrations.
 */
export const migration = <F extends ReadonlyTypeSchema, T extends ReadonlyTypeSchema>(
  from: TypeHandle<F>,
  to: TypeHandle<T>,
  fn: (content: StoredContentOf<F>) => NoInfer<StoredContentOf<T>>,
): Migration<StoredContentOf<F>, StoredContentOf<T>> => {
  if (to.baseId === from.baseId && to.migratesFrom !== from.id) {
    throw new StackMigrationError(
      `Cannot migrate "${from.id}" to "${to.id}": "${to.id}" migrates from ` +
        `${to.migratesFrom ? `"${to.migratesFrom}"` : 'nothing'}.`,
    );
  }
  return Object.freeze({ from: from.id, to: to.id, migrate: fn });
};

// -------------------------------------------------------
// Typed read and write options
// -------------------------------------------------------

/**
 * A typed read sees live records only and always reads at `presentAt:
 * 'latest'`, so neither knob is offered. See docs/spec/data-model.md § Type
 * handles.
 */
export type TypedQuery = Omit<StackQuery, 'filter' | 'presentAt'> & {
  filter?: Omit<RecordFilter, 'typeId' | 'baseId' | 'includeDeleted'>;
};

/**
 * A change whose `record`, when present, is the handle's content. Absent
 * where an untyped change's would be, and when the record has migrated off
 * the handle's version; the typed `get()` then says why.
 */
export type TypedChange<S extends ReadonlyTypeSchema> = Omit<RecordChange, 'record'> & {
  record?: TypedRecord<S>;
};

/** The family and version are the handle's, so neither is a filter key. */
export type TypedSubscribeOptions = Omit<SubscribeOptions, 'filter'> & {
  filter?: Omit<ChangeFilter, 'typeId' | 'baseId'>;
};

export type TypedChangeSet<S extends ReadonlyTypeSchema> = Omit<RecordChangeSet, 'contentPatch'> & {
  contentPatch?: PatchOf<S>;
};

// -------------------------------------------------------
// Runtime narrowing
// -------------------------------------------------------

/**
 * Narrow a record to a handle's content type: it must be exactly the
 * handle's Type. A record of another Type throws, and so does one whose
 * family has moved past the handle's version.
 */
export const narrowRecord = <S extends ReadonlyTypeSchema>(
  handle: TypeHandle<S>,
  record: StackRecord,
): TypedRecord<S> => {
  if (record.typeId !== handle.id) {
    throw new StackBadRequestError(`Record "${record.id}" is ${record.typeId}, not ${handle.id}`);
  }
  return record as TypedRecord<S>;
};

/** The ways a typed read can be asked to see a tombstone. */
export const assertLiveFilter = (filter: object | undefined): void => {
  if ((filter as RecordFilter | undefined)?.includeDeleted) {
    throw new StackBadRequestError(
      'A typed read sees live records only; use the untyped read to include soft-deleted records.',
    );
  }
};

// -------------------------------------------------------
// Typed operations, shared by Stack and ScopedStack
// -------------------------------------------------------

type TypedOps = Pick<StackClient, 'get' | 'query' | 'create' | 'mutate' | 'subscribe'>;

export const typedGet = async <S extends ReadonlyTypeSchema>(
  client: TypedOps,
  handle: TypeHandle<S>,
  id: RecordId,
): Promise<TypedRecord<S> | null> => {
  const record = await client.get(id, { presentAt: 'latest' });
  return record && narrowRecord(handle, record);
};

export const typedQuery = async <S extends ReadonlyTypeSchema>(
  client: TypedOps,
  handle: TypeHandle<S>,
  query: TypedQuery = {},
): Promise<{ records: TypedRecord<S>[]; cursor: string | null }> => {
  assertLiveFilter(query.filter);
  // The family, not the handle's version: a record still at an older
  // version must be migrated up, or refused as stale, never skipped.
  const result = await client.query({
    ...query,
    filter: { ...query.filter, baseId: handle.baseId },
    presentAt: 'latest',
  });
  return { ...result, records: result.records.map((r) => narrowRecord(handle, r)) };
};

export const typedCreate = async <S extends ReadonlyTypeSchema>(
  client: TypedOps,
  handle: TypeHandle<S>,
  content: ContentOf<S>,
  opts?: CreateRecordOptions,
): Promise<TypedRecord<S>> => client.create(handle.id, content, opts) as Promise<TypedRecord<S>>;

export const typedMutate = async <S extends ReadonlyTypeSchema>(
  client: TypedOps,
  handle: TypeHandle<S>,
  id: RecordId,
  changes: TypedChangeSet<S>,
  opts?: IfVersionOptions,
): Promise<TypedRecord<S>> => {
  // Checked against the read the write already makes, so nothing lands on
  // a record the handle does not type. See docs/spec/data-model.md § Type handles.
  const expect = {
    [WRITE_EXPECTATION]: { baseId: handle.baseId, typeId: handle.id, exact: true },
  };
  try {
    return narrowRecord(handle, await client.mutate(id, changes, { ...opts, ...expect } as never));
  } catch (err) {
    if (!(err instanceof StoredVersionError)) throw err;
    throw new StackBadRequestError(`Record "${id}" is ${err.record.typeId}, not ${handle.id}`);
  }
};

export const typedSubscribe = <S extends ReadonlyTypeSchema>(
  client: TypedOps,
  handle: TypeHandle<S>,
  handler: (change: TypedChange<S>) => void,
  opts: TypedSubscribeOptions = {},
): Promise<Unsubscribe> =>
  // Exactly the handle's version: an event carries its record as stored, so
  // a subscription cannot migrate it the way a typed read does, and a
  // record of another version has no honest typing here.
  client.subscribe(
    (change) => {
      const { record, ...rest } = change;
      // A record migrated off the handle's version still matches the filter
      // by its previous typeId, and arrives without `record`.
      handler(
        record?.typeId === handle.id ? { ...rest, record: narrowRecord(handle, record) } : rest,
      );
    },
    { ...opts, filter: { ...opts.filter, typeId: handle.id } },
  );
