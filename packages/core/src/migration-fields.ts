/**
 * Migration fields
 * -------------------------------------------------------
 * A migration declares where each of the target's top-level fields comes
 * from — a source field, its values possibly remapped; a constant; or a
 * value derived from the stored record — rather than being a function, so
 * that core can read what became of each field. Two things are built from
 * one declaration: the in-memory `migrate` that `Stack.open()`, a
 * collection's reads and `migrateAll()` run, and the field origins a
 * collection translates a content filter or sort through.
 *
 * Every origin reads the record as stored, so a declaration has no order
 * and names each field once. `fieldOrigins()` checks it against both
 * schemas, so a field the target Type would refuse fails when
 * `migration()` runs rather than on the first record `migrateAll()`
 * writes. See docs/spec/data-model.md § Migration fields.
 */

import type { FieldDef, TypeSchema } from './types/index.js';
import type { ReadonlyTypeSchema } from './type-handle.js';
import { validateContent } from './validate.js';

// -------------------------------------------------------
// Declaring fields
// -------------------------------------------------------

/**
 * One field's origin as declared: a `FieldOrigin` whose derivation carries
 * the function that computes it.
 */
export type DeclaredOrigin =
  | Exclude<FieldOrigin, { kind: 'derived' }>
  | { readonly kind: 'derived'; readonly derive: (content: Record<string, unknown>) => unknown };

declare const originBrand: unique symbol;

/**
 * An origin the builder made for a field whose write type is `V`, opaque
 * to the caller: its brand exists only in the types, so no other value
 * fits where one is expected.
 */
export type Origin<V> = { readonly [originBrand]: V };

declare const fieldsBrand: unique symbol;

/** The declaration `fields()` checks and returns. */
export type DeclaredFields = Readonly<Record<string, DeclaredOrigin>> & {
  readonly [fieldsBrand]: true;
};

/** The target's fields the source does not declare, so has no field to carry. */
type MustDeclare<F, T> = Exclude<keyof T, keyof F>;
/** The values a table may map: a string-shaped scalar's, or an array's elements'. */
type Mappable<V> = Exclude<V extends readonly (infer E)[] ? E : V, undefined> & string;
/**
 * The table `field()` takes for the source field `K`: keyed by the values
 * it lists. A misnamed field or an unlisted key makes the origin `never`,
 * so the compiler reports the argument at fault and nothing after it.
 */
type Table<S, K> = Readonly<
  Partial<
    Record<
      K extends keyof S
        ? (NonNullable<S[K]> extends readonly (infer E)[] ? E : NonNullable<S[K]>) & string
        : never,
      string
    >
  >
>;
type Unlisted<M, S, K> = [M] extends [never]
  ? never
  : Exclude<keyof M, K extends keyof S ? Mappable<S[K]> : never>;
/** `V` with each value `M` lists replaced by its mapping, element-wise. */
type Remapped<V, M> = V extends readonly (infer E)[]
  ? Remapped<E, M>[]
  : V extends keyof M
    ? M[V]
    : V;

/** What `fields()` takes: an origin for any of the target's fields, typed by its write type. */
export type MigrationFields<F, T> = {
  readonly [K in Exclude<keyof T, MustDeclare<F, T>>]?: Origin<T[K]>;
} & { readonly [K in MustDeclare<F, T>]: Origin<T[K]> };

/**
 * What `migration()` hands its callback, typed by both handles: `F` is the
 * content stored at `from`, `S` the content written there, whose listed
 * values are what a carried field is checked by, and `T` the content
 * written at `to`. Each origin takes its type from the field it is
 * declared for. See docs/spec/data-model.md § Migration fields.
 */
export type MigrationBuilder<F, S, T> = {
  /** The declaration, one origin per field it names. */
  readonly fields: (fields: MigrationFields<F, T>) => DeclaredFields;
  /**
   * The value of the source field `source`, with each value `values` lists
   * replaced by its mapping, element-wise through an array. A stored enum
   * may hold a value no handle lists, and it is carried through.
   */
  readonly field: <K extends string, const M extends Readonly<Record<string, string>> = never>(
    source: K extends keyof S ? K : keyof S & string,
    values?: Unlisted<M, S, K> extends never ? M : Table<S, K>,
  ) => Origin<
    K extends keyof S
      ? [M] extends [never]
        ? S[K]
        : Unlisted<M, S, K> extends never
          ? Remapped<S[K], M>
          : never
      : never
  >;
  /** A constant. */
  readonly constant: <V>(value: NoInfer<Exclude<V, undefined>>) => Origin<V>;
  /**
   * What `fn` computes from the record as stored at `from`; `undefined`
   * leaves the field absent. The one opaque origin: a field it produces
   * does not translate across versions.
   */
  readonly derive: <V>(fn: (content: F) => NoInfer<V>) => Origin<V>;
  /** No value: the field is left absent. */
  readonly absent: () => Origin<undefined>;
};

/** The one builder, untyped; `migration()` passes it typed by its handles. */
export const migrationBuilder: MigrationBuilder<
  Record<string, unknown>,
  Record<string, unknown>,
  Record<string, unknown>
> = Object.freeze({
  // An optional key may be given as undefined, which declares nothing.
  fields: (fields) =>
    Object.freeze(
      Object.fromEntries(Object.entries(fields).filter(([, origin]) => origin !== undefined)),
    ) as unknown as DeclaredFields,
  field: (source, values) =>
    Object.freeze({
      kind: 'field',
      field: source,
      ...(values && { values: Object.freeze({ ...values }) as Readonly<Record<string, string>> }),
    }) as unknown as Origin<never>,
  constant: (value) => Object.freeze({ kind: 'constant', value }) as unknown as Origin<never>,
  derive: (fn) => Object.freeze({ kind: 'derived', derive: fn }) as unknown as Origin<never>,
  absent: () =>
    Object.freeze({ kind: 'constant', value: undefined }) as unknown as Origin<undefined>,
});

const describe = (origin: DeclaredOrigin): string => {
  switch (origin.kind) {
    case 'field':
      return `field("${origin.field}"${origin.values ? ', …' : ''})`;
    case 'constant':
      return origin.value === undefined ? 'absent()' : 'constant(…)';
    case 'derived':
      return 'derive(…)';
  }
};

// -------------------------------------------------------
// Applying a declaration
// -------------------------------------------------------

const remap = (value: unknown, values: Readonly<Record<string, string>>): unknown => {
  if (Array.isArray(value)) return value.map((v) => remap(v, values));
  return typeof value === 'string' && Object.hasOwn(values, value) ? values[value] : value;
};

/**
 * The content `fields` produce from `content`, which is left untouched:
 * each declared field set from its origin, each field `from` declares and
 * `to` does not removed, and every other field carried as it is.
 */
export const applyFields = (
  fields: DeclaredFields,
  from: ReadonlyTypeSchema,
  to: ReadonlyTypeSchema,
  content: Record<string, unknown>,
): Record<string, unknown> => {
  const out: Record<string, unknown> = { ...content };
  for (const field of Object.keys(from)) if (!Object.hasOwn(to, field)) delete out[field];
  for (const [field, origin] of Object.entries(fields)) {
    const value =
      origin.kind === 'field'
        ? origin.values && content[origin.field] !== undefined
          ? remap(content[origin.field], origin.values)
          : content[origin.field]
        : origin.kind === 'constant'
          ? origin.value
          : origin.derive(content);
    if (value === undefined) delete out[field];
    else out[field] = value;
  }
  return out;
};

// -------------------------------------------------------
// Field origins
// -------------------------------------------------------

/**
 * What one of the target's top-level fields is, in terms of the source's:
 * a source field, its string values possibly remapped; a constant, where
 * `undefined` is no value; or derived, which nothing can see through.
 */
export type FieldOrigin =
  | {
      readonly kind: 'field';
      readonly field: string;
      readonly values?: Readonly<Record<string, string>>;
    }
  | { readonly kind: 'constant'; readonly value: unknown }
  | { readonly kind: 'derived' };

/**
 * Every top-level field the target declares, by its origin, and every
 * field of the source it does not declare, as no value.
 */
export type FieldOrigins = ReadonlyMap<string, FieldOrigin>;

/** `outer` after `inner`, as one table over both domains. */
const composeValues = (
  inner: Readonly<Record<string, string>> | undefined,
  outer: Readonly<Record<string, string>> | undefined,
): Readonly<Record<string, string>> | undefined => {
  if (!inner) return outer;
  if (!outer) return inner;
  const composed: Record<string, string> = {};
  for (const [from, to] of Object.entries(inner)) composed[from] = remap(to, outer) as string;
  for (const [from, to] of Object.entries(outer)) {
    if (!Object.hasOwn(inner, from)) composed[from] = to;
  }
  return composed;
};

/**
 * The origins across two migrations end to end: `lower` takes A to B and
 * `upper` takes B to C, so the result says what each of C's fields is in
 * terms of A's.
 */
export const composeOrigins = (lower: FieldOrigins, upper: FieldOrigins): FieldOrigins => {
  const composed = new Map<string, FieldOrigin>();
  for (const [field, origin] of upper) {
    if (origin.kind !== 'field') {
      composed.set(field, origin);
      continue;
    }
    // A name the lower migration neither declares nor removed passes through it.
    const inner = lower.get(origin.field) ?? { kind: 'field', field: origin.field };
    composed.set(
      field,
      inner.kind === 'field'
        ? { kind: 'field', field: inner.field, values: composeValues(inner.values, origin.values) }
        : inner.kind === 'constant'
          ? {
              kind: 'constant',
              value: origin.values ? remap(inner.value, origin.values) : inner.value,
            }
          : inner,
    );
  }
  return composed;
};

const isStringKind = (def: FieldDef | undefined): boolean =>
  def?.kind === 'enum' || def?.kind === 'string' || def?.kind === 'text';

/** What a table may remap: a string-shaped scalar, or a declared array of one. */
const isMappable = (def: FieldDef | undefined): boolean =>
  isStringKind(def) || (def?.kind === 'array' && !def.open && isStringKind(def.items));

/** The values an enum, or an array of one, lists; null for free text. */
const listedValues = (def: FieldDef): readonly string[] | null => {
  const scalar = def.kind === 'array' && !def.open ? def.items : def;
  return scalar.kind === 'enum' ? scalar.values : null;
};

const MAX_CARRY_DEPTH = 32;

/**
 * Why a value stored under `source` could fail `target` once `values`
 * remaps it, or null when it cannot. A carried field is written as it
 * stands, so this is write validity, not the read compatibility
 * isCompatible() answers.
 */
const carryProblem = (
  path: string,
  source: FieldDef,
  target: FieldDef,
  values: Readonly<Record<string, string>> | undefined,
  depth: number,
): string | null => {
  if (depth > MAX_CARRY_DEPTH) return `"${path}" nests too deeply to check`;
  if (target.required && !source.required) {
    return `"${path}" is optional at the source and required at the target`;
  }
  if (target.kind === 'array') {
    if (source.kind !== 'array') return `"${path}" changes kind from ${source.kind} to array`;
    if (target.open) return null;
    if (source.open) return `"${path}" is an open array at the source and declared at the target`;
    return carryProblem(`${path}[]`, source.items, target.items, values, depth + 1);
  }
  if (target.kind === 'object') {
    if (source.kind !== 'object') return `"${path}" changes kind from ${source.kind} to object`;
    if (target.open) return null;
    if (source.open) return `"${path}" is an open object at the source and declared at the target`;
    for (const [key, def] of Object.entries(target.properties)) {
      const from = source.properties[key];
      if (!from) {
        if (def.required) return `"${path}.${key}" is required at the target and not at the source`;
        continue;
      }
      const problem = carryProblem(`${path}.${key}`, from, def, undefined, depth + 1);
      if (problem) return problem;
    }
    for (const key of Object.keys(source.properties)) {
      if (!Object.hasOwn(target.properties, key)) {
        return `"${path}.${key}" is not declared at the target`;
      }
    }
    return null;
  }
  if (target.kind === 'enum') {
    if (source.kind !== 'enum') return `"${path}" changes kind from ${source.kind} to enum`;
    const allowed = new Set(target.values);
    const missing = source.values.find((v) => !allowed.has(remap(v, values ?? {}) as string));
    return missing === undefined
      ? null
      : `"${path}" holds "${missing}"${values && Object.hasOwn(values, missing) ? ` (mapped to "${values[missing]}")` : ''}, which the target's enum does not list`;
  }
  if (target.kind === 'string' || target.kind === 'text') {
    return isStringKind(source)
      ? null
      : `"${path}" changes kind from ${source.kind} to ${target.kind}`;
  }
  return source.kind === target.kind
    ? null
    : `"${path}" changes kind from ${source.kind} to ${target.kind}`;
};

/**
 * What each of `to`'s top-level fields is in terms of `from`'s, under
 * `fields`. Returns the problem that makes the declaration unusable as a
 * string instead: a name `to` does not declare, an origin reading a field
 * or mapping a value the source does not, or a field `to` would refuse.
 * See docs/spec/data-model.md § Migration fields.
 */
export const fieldOrigins = (
  fields: DeclaredFields,
  from: ReadonlyTypeSchema,
  to: ReadonlyTypeSchema,
): FieldOrigins | string => {
  for (const [field, origin] of Object.entries(fields)) {
    const at = `"${field}": ${describe(origin)}`;
    if (!Object.hasOwn(to, field)) return `${at}: the target does not declare "${field}"`;
    if (origin.kind !== 'field') continue;
    const source = Object.hasOwn(from, origin.field) ? (from[origin.field] as FieldDef) : undefined;
    if (!source) return `${at}: "${origin.field}" is not a field of the source`;
    if (!origin.values) continue;
    if (!isMappable(source)) {
      return `${at}: only an enum, string or text field, or an array of one, can be mapped`;
    }
    const listed = listedValues(source);
    const unlisted = listed && Object.keys(origin.values).find((v) => !listed.includes(v));
    if (unlisted) return `${at}: maps "${unlisted}", which "${origin.field}" does not list`;
  }

  // A field the target does not declare is removed, as no value.
  const origins = new Map<string, FieldOrigin>(
    Object.keys(from)
      .filter((field) => !Object.hasOwn(to, field))
      .map((field) => [field, { kind: 'constant', value: undefined }]),
  );
  for (const [field, def] of Object.entries(to)) {
    const declaredOrigin = Object.hasOwn(fields, field) ? fields[field] : undefined;
    // A field no origin names is carried from the source's field of the
    // same name, which the source must declare.
    const origin: FieldOrigin = declaredOrigin
      ? declaredOrigin.kind === 'derived'
        ? { kind: 'derived' }
        : declaredOrigin
      : { kind: 'field', field };
    if (!declaredOrigin && !Object.hasOwn(from, field)) {
      return `the source does not declare "${field}", so its origin must be declared`;
    }
    if (origin.kind === 'field') {
      const problem = carryProblem(
        field,
        from[origin.field] as FieldDef,
        def as FieldDef,
        origin.values,
        0,
      );
      if (problem) return problem;
    } else if (origin.kind === 'constant') {
      const errors = validateContent(origin.value === undefined ? {} : { [field]: origin.value }, {
        [field]: def,
      } as TypeSchema);
      if (errors.length > 0) {
        return `"${field}" is set to a value the target refuses: ${errors[0].message}`;
      }
    }
    origins.set(field, origin);
  }
  return origins;
};

// -------------------------------------------------------
// Registry of origins
// -------------------------------------------------------

/**
 * The origins `migration()` computed for each migration it built. A
 * migration assembled by hand has none, and a collection reads every field
 * across it as derived.
 */
const ORIGINS = new WeakMap<object, FieldOrigins>();

export const recordOrigins = (migration: object, origins: FieldOrigins): void => {
  ORIGINS.set(migration, origins);
};

export const originsOf = (migration: object): FieldOrigins | undefined => ORIGINS.get(migration);
