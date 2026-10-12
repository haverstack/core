/**
 * Migration steps
 * -------------------------------------------------------
 * A migration is a list of declared steps — rename, map, add, drop and
 * derive — rather than a function, so that core can read what became of
 * each field. Two things are built from one list: the in-memory `migrate`
 * that `Stack.open()`, a collection's reads and `migrateAll()` run, and the
 * field origins a collection translates a content filter or sort through.
 *
 * `fieldOrigins()` also checks the list against both schemas, so a step
 * the target Type would refuse fails when `migration()` runs rather than
 * on the first record `migrateAll()` writes. See docs/spec/data-model.md
 * § Migration steps.
 */

import type { FieldDef, TypeSchema } from './types/index.js';
import type { ReadonlyTypeSchema } from './type-handle.js';
import { validateContent } from './validate.js';

// -------------------------------------------------------
// Steps
// -------------------------------------------------------

export type RenameStep = { readonly op: 'rename'; readonly from: string; readonly to: string };
export type MapStep = {
  readonly op: 'map';
  readonly field: string;
  readonly values: Readonly<Record<string, string>>;
};
export type AddStep = { readonly op: 'add'; readonly field: string; readonly value: unknown };
export type DropStep = { readonly op: 'drop'; readonly field: string };
/**
 * `derive` is a method so a step typed on one handle's content fits a list
 * of untyped ones, as `Migration.migrate` does.
 */
export type DeriveStep<F = Record<string, unknown>> = {
  readonly op: 'derive';
  readonly field: string;
  derive(content: F): unknown;
};

/** One step of a migration, typed on the content stored at its `from`. */
export type MigrationStep<F = Record<string, unknown>> =
  | RenameStep
  | MapStep
  | AddStep
  | DropStep
  | DeriveStep<F>;

/** Move a field's value to a new name. */
export const rename = (from: string, to: string): RenameStep =>
  Object.freeze({ op: 'rename', from, to });

/**
 * Replace each value `values` lists with its mapping, keeping any other,
 * element-wise through an array. A stored enum may hold a value no handle
 * lists, and it is carried through rather than lost.
 */
export const map = (field: string, values: Readonly<Record<string, string>>): MapStep =>
  Object.freeze({ op: 'map', field, values: Object.freeze({ ...values }) });

/** Set a field to a constant. */
export const add = (field: string, value: unknown): AddStep =>
  Object.freeze({ op: 'add', field, value });

/** Remove a field. */
export const drop = (field: string): DropStep => Object.freeze({ op: 'drop', field });

/**
 * Set a field to what `fn` computes from the record as stored at the
 * migration's `from`; `undefined` leaves it absent. The one opaque step: a
 * field it produces does not translate across versions.
 */
export const derive = <F>(field: string, fn: (content: F) => unknown): DeriveStep<F> =>
  Object.freeze({ op: 'derive', field, derive: fn });

const describe = (step: MigrationStep<never>): string => {
  switch (step.op) {
    case 'rename':
      return `rename("${step.from}", "${step.to}")`;
    case 'add':
      return `add("${step.field}", …)`;
    default:
      return `${step.op}("${step.field}"${step.op === 'drop' ? '' : ', …'})`;
  }
};

// -------------------------------------------------------
// Applying steps
// -------------------------------------------------------

const remap = (value: unknown, values: Readonly<Record<string, string>>): unknown => {
  if (Array.isArray(value)) return value.map((v) => remap(v, values));
  return typeof value === 'string' && Object.hasOwn(values, value) ? values[value] : value;
};

/** The content `steps` produce from `content`, which is left untouched. */
export const applySteps = (
  steps: readonly MigrationStep[],
  content: Record<string, unknown>,
): Record<string, unknown> => {
  const out: Record<string, unknown> = { ...content };
  for (const step of steps) {
    switch (step.op) {
      case 'rename':
        if (Object.hasOwn(out, step.from)) out[step.to] = out[step.from];
        delete out[step.from];
        break;
      case 'map':
        if (out[step.field] !== undefined) out[step.field] = remap(out[step.field], step.values);
        break;
      case 'add':
        out[step.field] = step.value;
        break;
      case 'drop':
        delete out[step.field];
        break;
      case 'derive': {
        const value = step.derive(content);
        if (value === undefined) delete out[step.field];
        else out[step.field] = value;
        break;
      }
    }
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

/** Every top-level field the target declares, by its origin. */
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
    const inner = lower.get(origin.field) ?? { kind: 'derived' };
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

/** What `map` may remap: a string-shaped scalar, or a declared array of one. */
const isMappable = (def: FieldDef | undefined): boolean =>
  isStringKind(def) || (def?.kind === 'array' && !def.open && isStringKind(def.items));

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
 * What each of `to`'s top-level fields is in terms of `from`'s, after
 * `steps`. Returns the problem that makes the list unusable as a string
 * instead: a step naming a field that is not there, a field `to` would
 * refuse, or one it requires that nothing produces. See
 * docs/spec/data-model.md § Migration steps.
 */
export const fieldOrigins = (
  steps: readonly MigrationStep<never>[],
  from: ReadonlyTypeSchema,
  to: ReadonlyTypeSchema,
): FieldOrigins | string => {
  const current = new Map<string, FieldOrigin>(
    Object.keys(from).map((field) => [field, { kind: 'field', field }]),
  );
  for (const step of steps) {
    const at = describe(step);
    const named = step.op === 'rename' ? step.from : step.field;
    if (step.op !== 'add' && step.op !== 'derive' && !current.has(named)) {
      return `${at}: "${named}" is not a field at this point`;
    }
    switch (step.op) {
      case 'rename':
        if (current.has(step.to)) return `${at}: "${step.to}" is already a field at this point`;
        current.set(step.to, current.get(step.from)!);
        current.delete(step.from);
        break;
      case 'map': {
        const origin = current.get(step.field)!;
        if (origin.kind === 'field') {
          if (!isMappable(from[origin.field] as FieldDef | undefined)) {
            return `${at}: only an enum, string or text field, or an array of one, can be mapped`;
          }
          current.set(step.field, {
            ...origin,
            values: composeValues(origin.values, step.values),
          });
        } else if (origin.kind === 'constant') {
          current.set(step.field, { kind: 'constant', value: remap(origin.value, step.values) });
        }
        break;
      }
      case 'add':
        if (current.has(step.field))
          return `${at}: "${step.field}" is already a field at this point`;
        if (step.value === undefined) return `${at}: an added field needs a value`;
        current.set(step.field, { kind: 'constant', value: step.value });
        break;
      case 'drop':
        current.delete(step.field);
        break;
      case 'derive':
        current.set(step.field, { kind: 'derived' });
        break;
    }
  }

  for (const field of current.keys()) {
    if (!Object.hasOwn(to, field)) {
      return `"${field}" is carried to a Type that does not declare it; drop or rename it`;
    }
  }
  for (const [field, def] of Object.entries(to)) {
    const origin = current.get(field);
    if (!origin) {
      if (def.required) return `"${field}" is required at the target, and no step produces it`;
      current.set(field, { kind: 'constant', value: undefined });
      continue;
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
      const errors = validateContent({ [field]: origin.value }, { [field]: def } as TypeSchema);
      if (errors.length > 0)
        return `"${field}" is set to a value the target refuses: ${errors[0].message}`;
    }
  }
  return current;
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
