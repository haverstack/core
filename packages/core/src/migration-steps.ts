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
export type DeriveStep = {
  readonly op: 'derive';
  readonly field: string;
  readonly derive: (content: Record<string, unknown>) => unknown;
};

/** One step of a migration. */
export type MigrationStep = RenameStep | MapStep | AddStep | DropStep | DeriveStep;

/**
 * The steps `migration()` hands its `steps` function, typed by both handles:
 * `F` is the content stored at `from`, `T` the content written at `to`.
 * `add` and `derive` produce a target field, so each takes one of `T`'s
 * fields and that field's write type, and no later step may name it.
 * `rename`, `map` and `drop` name a field at a point in the list, which
 * `migration()` checks when it runs.
 * See docs/spec/data-model.md § Migration steps.
 */
export type Steps<F, T> = {
  /** Move a field's value to a new name. */
  readonly rename: (from: string, to: string) => RenameStep;
  /**
   * Replace each value `values` lists with its mapping, keeping any other,
   * element-wise through an array. A stored enum may hold a value no handle
   * lists, and it is carried through rather than lost.
   */
  readonly map: (field: string, values: Readonly<Record<string, string>>) => MapStep;
  /** Remove a field. */
  readonly drop: (field: string) => DropStep;
  /** Set a target field to a constant, replacing what it held. */
  readonly add: <K extends keyof T & string>(field: K, value: Exclude<T[K], undefined>) => AddStep;
  /**
   * Set a target field to what `fn` computes from the record as stored at
   * `from`, replacing what it held; `undefined` leaves it absent. The one opaque step: a field it
   * produces does not translate across versions.
   */
  readonly derive: <K extends keyof T & string>(field: K, fn: (content: F) => T[K]) => DeriveStep;
};

/** The one builder, untyped; `migration()` passes it typed by its handles. */
export const stepBuilder: Steps<Record<string, unknown>, Record<string, unknown>> = Object.freeze({
  rename: (from: string, to: string): RenameStep => Object.freeze({ op: 'rename', from, to }),
  map: (field: string, values: Readonly<Record<string, string>>): MapStep =>
    Object.freeze({ op: 'map', field, values: Object.freeze({ ...values }) }),
  drop: (field: string): DropStep => Object.freeze({ op: 'drop', field }),
  add: (field: string, value: unknown): AddStep => Object.freeze({ op: 'add', field, value }),
  derive: (field: string, fn: (content: Record<string, unknown>) => unknown): DeriveStep =>
    Object.freeze({ op: 'derive', field, derive: fn }),
});

const describe = (step: MigrationStep): string => {
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

/**
 * Every top-level field the target declares, by its origin, and every name
 * the steps removed, as no value.
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
    // A name the lower step neither declares nor removed passes through it.
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
  steps: readonly MigrationStep[],
  from: ReadonlyTypeSchema,
  to: ReadonlyTypeSchema,
): FieldOrigins | string => {
  const current = new Map<string, FieldOrigin>(
    Object.keys(from).map((field) => [field, { kind: 'field', field }]),
  );
  const removed = new Set<string>();
  // A step that produces a field is typed by the target's declaration of
  // it, which only holds if no later step touches what it produced.
  const producedBy = new Map<string, string>();
  for (const step of steps) {
    const at = describe(step);
    const named = step.op === 'rename' ? step.from : step.field;
    const producer = producedBy.get(named);
    if (producer) return `${at}: "${named}" is produced by ${producer}, which sets its final value`;
    if (step.op === 'add' || step.op === 'derive') producedBy.set(step.field, at);
    else if (!current.has(named)) return `${at}: "${named}" is not a field at this point`;
    switch (step.op) {
      case 'rename':
        if (current.has(step.to)) return `${at}: "${step.to}" is already a field at this point`;
        current.set(step.to, current.get(step.from)!);
        current.delete(step.from);
        removed.add(step.from);
        break;
      case 'map': {
        // A name no step produced is a source field, under its own name or another.
        const origin = current.get(step.field) as Extract<FieldOrigin, { kind: 'field' }>;
        if (!isMappable(from[origin.field] as FieldDef | undefined)) {
          return `${at}: only an enum, string or text field, or an array of one, can be mapped`;
        }
        current.set(step.field, { ...origin, values: composeValues(origin.values, step.values) });
        break;
      }
      case 'add':
        if (step.value === undefined) return `${at}: an added field needs a value`;
        current.set(step.field, { kind: 'constant', value: step.value });
        break;
      case 'drop':
        current.delete(step.field);
        removed.add(step.field);
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
      // migrate() carries every field no step names, so one an older
      // version gained in place arrives under its own name.
      current.set(
        field,
        removed.has(field) ? { kind: 'constant', value: undefined } : { kind: 'field', field },
      );
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
  for (const field of removed) {
    if (!current.has(field)) current.set(field, { kind: 'constant', value: undefined });
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
