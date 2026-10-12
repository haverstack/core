/**
 * Stack — Type handles
 * -------------------------------------------------------
 * A Type's schema written once as a literal, from which the compiler derives
 * the content type: `ContentOf` for a create, `StoredContentOf` for a read.
 * A handle is a plain value, so `StackClient`
 * code can use it wherever it has no `defineType()` result.
 *
 * The derived types layer over runtime validation, which stays the guarantee.
 * A handle reaches records through `client.collection(handle)`; see
 * collection.ts and docs/spec/data-model.md § Type handles.
 */

import { StackBadRequestError, StackMigrationError } from './errors.js';
import { lineageProblem, parseTypeId } from './schema.js';
import type { BaseId, ScalarFieldKind, TypeId } from './types/index.js';
import { applySteps, fieldOrigins, recordOrigins } from './migration-steps.js';
import type { MigrationStep } from './migration-steps.js';

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
 * `types` and `StackClient.collection()`. A handle names exactly
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

// -------------------------------------------------------
// Migrations
// -------------------------------------------------------

/**
 * A step from one version of a type to another, passed to `Stack.open()`
 * and typed on both versions' content. `steps` is what a collection reads
 * to carry a content query across versions; `migrate` applies them, and is
 * a method so a typed migration fits a list of untyped ones. See
 * docs/spec/data-model.md § Type migrations.
 */
export type Migration<From = Record<string, unknown>, To = Record<string, unknown>> = {
  readonly from: TypeId;
  readonly to: TypeId;
  readonly steps: readonly MigrationStep<From>[];
  migrate(content: From): To;
};

/**
 * Build the migration from `from` to `to` out of declared steps, checked
 * against both handles' schemas here: a step naming a field that is not
 * there, a field `to` would refuse, or a required one nothing produces
 * throws `StackMigrationError`. `derive` reads `from`'s stored content, in
 * which an enum may hold a value neither handle lists. Within a family,
 * `to` must name `from` as its `migratesFrom`; a step into another family
 * has no lineage to check. See docs/spec/data-model.md § Migration steps.
 */
export const migration = <F extends ReadonlyTypeSchema, T extends ReadonlyTypeSchema>(
  from: TypeHandle<F>,
  to: TypeHandle<T>,
  steps: readonly MigrationStep<NoInfer<StoredContentOf<F>>>[],
): Migration<StoredContentOf<F>, StoredContentOf<T>> => {
  const refuse = (problem: string) =>
    new StackMigrationError(`Cannot migrate "${from.id}" to "${to.id}": ${problem}.`);
  if (to.baseId === from.baseId && to.migratesFrom !== from.id) {
    throw refuse(
      `"${to.id}" migrates from ${to.migratesFrom ? `"${to.migratesFrom}"` : 'nothing'}`,
    );
  }
  const frozen = Object.freeze([...steps]) as readonly MigrationStep[];
  const origins = fieldOrigins(frozen, from.schema, to.schema);
  if (typeof origins === 'string') throw refuse(origins);
  const built = Object.freeze({
    from: from.id,
    to: to.id,
    steps: frozen,
    migrate: (content: Record<string, unknown>) => applySteps(frozen, content),
  }) as unknown as Migration<StoredContentOf<F>, StoredContentOf<T>>;
  recordOrigins(built, origins);
  return built;
};
