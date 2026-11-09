/**
 * UCAN policy language
 * -------------------------------------------------------
 * A delegation's `pol` constrains the arguments of whatever it is used to
 * authorize: an array of predicates, all of which must hold, written over
 * jq-like selectors. This module parses a policy, refusing anything outside
 * the grammar, and evaluates a parsed one against an arguments object.
 *
 * Where the UCAN Delegation spec is ambiguous, the reading taken here is
 * pinned by this package's tests:
 *
 * - A quantifier (`all`, `any`) takes one statement, as the spec's schema
 *   and every example give it, not the list its operator table shows.
 * - An empty `or` is true, as the spec states, and so is `any` over an
 *   empty collection, which the spec defines as an `or` of its elements.
 * - `[]` applies the rest of a selector to every element; if any element
 *   fails to resolve, the whole selector does.
 */

import { CID } from 'multiformats/cid';
import { UcanError } from './errors.js';

/** A value in the IPLD data model, as @ipld/dag-cbor decodes it. */
export type IpldValue =
  | null
  | boolean
  | number
  | string
  | Uint8Array
  | CID
  | IpldValue[]
  | { [key: string]: IpldValue };

type Segment =
  | { kind: 'field'; name: string; optional: boolean }
  | { kind: 'index'; index: number; optional: boolean }
  | { kind: 'slice'; start?: number; end?: number; optional: boolean }
  | { kind: 'values'; optional: boolean };

export type Selector = { source: string; segments: Segment[] };

export type Statement =
  | { op: '==' | '!='; selector: Selector; value: IpldValue }
  | { op: '<' | '<=' | '>' | '>='; selector: Selector; value: number }
  | { op: 'like'; selector: Selector; pattern: string }
  | { op: 'not'; statement: Statement }
  | { op: 'and' | 'or'; statements: Statement[] }
  | { op: 'all' | 'any'; selector: Selector; statement: Statement };

export type Policy = Statement[];

const malformed = (message: string): UcanError => new UcanError('malformed', message);

// -------------------------------------------------------
// Selectors
// -------------------------------------------------------

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*/;
const INT = /^-?(0|[1-9][0-9]*)$/;

/**
 * Parse a selector: `.`, then dotted fields and bracketed segments, each
 * optionally followed by `?`. A selector begins with a single dot, and no
 * two dots ever stand together.
 */
export const parseSelector = (source: string): Selector => {
  if (typeof source !== 'string' || !source.startsWith('.')) {
    throw malformed(`Selector must begin with ".": ${JSON.stringify(source)}`);
  }
  if (source === '.') return { source, segments: [] };

  const segments: Segment[] = [];
  let i = 0;
  const markOptional = () => {
    if (source[i] !== '?') return;
    while (source[i] === '?') i++;
    segments[segments.length - 1]!.optional = true;
  };

  while (i < source.length) {
    if (source[i] === '.') {
      i++;
      const ident = IDENT.exec(source.slice(i));
      if (ident) {
        segments.push({ kind: 'field', name: ident[0], optional: false });
        i += ident[0].length;
        markOptional();
        continue;
      }
      // A dot may introduce a bracket (`.[0]`) but nothing else.
      if (source[i] !== '[') throw malformed(`Invalid selector: ${JSON.stringify(source)}`);
    }
    if (source[i] !== '[') throw malformed(`Invalid selector: ${JSON.stringify(source)}`);

    const close = bracketEnd(source, i);
    const inner = source.slice(i + 1, close);
    segments.push(parseBracket(inner, source));
    i = close + 1;
    markOptional();
  }
  return { source, segments };
};

/** The index of the `]` closing the bracket opened at `open`, skipping a quoted key. */
const bracketEnd = (source: string, open: number): number => {
  let i = open + 1;
  if (source[i] === '"') {
    i++;
    while (i < source.length && source[i] !== '"') i += source[i] === '\\' ? 2 : 1;
    i++;
  }
  const close = source.indexOf(']', i);
  if (close === -1) throw malformed(`Unclosed bracket in selector: ${JSON.stringify(source)}`);
  return close;
};

const parseBracket = (inner: string, source: string): Segment => {
  if (inner === '') return { kind: 'values', optional: false };
  if (inner.startsWith('"')) {
    let name: unknown;
    try {
      name = JSON.parse(inner);
    } catch {
      throw malformed(`Invalid field name in selector: ${JSON.stringify(source)}`);
    }
    if (typeof name !== 'string') throw malformed(`Invalid selector: ${JSON.stringify(source)}`);
    return { kind: 'field', name, optional: false };
  }
  if (INT.test(inner)) return { kind: 'index', index: Number(inner), optional: false };
  const colon = inner.indexOf(':');
  if (colon !== -1) {
    const [a, b] = [inner.slice(0, colon), inner.slice(colon + 1)];
    if ((a === '' || INT.test(a)) && (b === '' || INT.test(b))) {
      return {
        kind: 'slice',
        ...(a !== '' && { start: Number(a) }),
        ...(b !== '' && { end: Number(b) }),
        optional: false,
      };
    }
  }
  throw malformed(`Invalid selector: ${JSON.stringify(source)}`);
};

const isMap = (value: unknown): value is { [key: string]: IpldValue } =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  !(value instanceof Uint8Array) &&
  CID.asCID(value) === null;

type Resolved = { ok: true; value: IpldValue } | { ok: false };
const FAIL: Resolved = { ok: false };

const resolveSegment = (segment: Segment, value: IpldValue): Resolved => {
  switch (segment.kind) {
    case 'field':
      if (!isMap(value)) return FAIL;
      // A missing key selects null; a selector that goes on past it fails there.
      return { ok: true, value: Object.hasOwn(value, segment.name) ? value[segment.name]! : null };
    case 'index': {
      if (!Array.isArray(value) && !(value instanceof Uint8Array)) return FAIL;
      const at = segment.index < 0 ? value.length + segment.index : segment.index;
      if (at < 0 || at >= value.length) return FAIL;
      return { ok: true, value: value[at]! };
    }
    case 'slice': {
      if (!Array.isArray(value) && !(value instanceof Uint8Array)) return FAIL;
      return { ok: true, value: value.slice(segment.start, segment.end) };
    }
    case 'values':
      if (Array.isArray(value)) return { ok: true, value };
      if (isMap(value)) return { ok: true, value: Object.values(value) };
      return FAIL;
  }
};

const resolveFrom = (segments: Segment[], from: number, value: IpldValue): Resolved => {
  let current = value;
  for (let i = from; i < segments.length; i++) {
    const segment = segments[i]!;
    const step = resolveSegment(segment, current);
    if (!step.ok) {
      if (!segment.optional) return FAIL;
      current = null;
      continue;
    }
    if (segment.kind === 'values') {
      const results: IpldValue[] = [];
      for (const element of step.value as IpldValue[]) {
        const rest = resolveFrom(segments, i + 1, element);
        if (!rest.ok) return FAIL;
        results.push(rest.value);
      }
      return { ok: true, value: results };
    }
    current = step.value;
  }
  return { ok: true, value: current };
};

/** Resolve a selector against a value; `{ ok: false }` when a segment can't be resolved. */
export const resolveSelector = (selector: Selector, value: IpldValue): Resolved =>
  resolveFrom(selector.segments, 0, value);

// -------------------------------------------------------
// Statements
// -------------------------------------------------------

const COMPARISONS = new Set(['<', '<=', '>', '>=']);

/** Parse and validate a policy, refusing any statement outside the grammar. */
export const parsePolicy = (pol: unknown): Policy => {
  if (!Array.isArray(pol)) throw malformed('Policy must be an array of statements.');
  return pol.map(parseStatement);
};

const parseStatement = (raw: unknown): Statement => {
  if (!Array.isArray(raw) || typeof raw[0] !== 'string') {
    throw malformed(`Invalid policy statement: ${describe(raw)}`);
  }
  const op = raw[0];
  const arity = (n: number) => {
    if (raw.length !== n) throw malformed(`"${op}" takes ${n - 1} argument(s): ${describe(raw)}`);
  };
  switch (op) {
    case '==':
    case '!=':
      arity(3);
      return { op, selector: parseSelector(raw[1]), value: raw[2] as IpldValue };
    case 'like':
      arity(3);
      if (typeof raw[2] !== 'string') throw malformed(`"like" takes a string pattern.`);
      return { op, selector: parseSelector(raw[1]), pattern: raw[2] };
    case 'not':
      arity(2);
      return { op, statement: parseStatement(raw[1]) };
    case 'and':
    case 'or':
      arity(2);
      if (!Array.isArray(raw[1])) throw malformed(`"${op}" takes an array of statements.`);
      return { op, statements: raw[1].map(parseStatement) };
    case 'all':
    case 'any':
      arity(3);
      return { op, selector: parseSelector(raw[1]), statement: parseStatement(raw[2]) };
    default:
      if (COMPARISONS.has(op)) {
        arity(3);
        if (typeof raw[2] !== 'number' || !Number.isFinite(raw[2])) {
          throw malformed(`"${op}" compares against a number.`);
        }
        return {
          op: op as '<' | '<=' | '>' | '>=',
          selector: parseSelector(raw[1]),
          value: raw[2],
        };
      }
      throw malformed(`Unknown policy operator "${op}".`);
  }
};

const describe = (value: unknown): string => {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
};

/** Whether `args` satisfies every statement of `policy`. */
export const evaluatePolicy = (policy: Policy, args: IpldValue): boolean =>
  policy.every((statement) => evaluate(statement, args));

const evaluate = (statement: Statement, value: IpldValue): boolean => {
  switch (statement.op) {
    case '==': {
      const r = resolveSelector(statement.selector, value);
      return r.ok && ipldEquals(r.value, statement.value);
    }
    case '!=':
      // Defined as ["not", ["==", ...]], so an unresolvable selector satisfies it.
      return !evaluate({ ...statement, op: '==' }, value);
    case '<':
    case '<=':
    case '>':
    case '>=': {
      const r = resolveSelector(statement.selector, value);
      if (!r.ok || typeof r.value !== 'number') return false;
      return compare(statement.op, r.value, statement.value);
    }
    case 'like': {
      const r = resolveSelector(statement.selector, value);
      return r.ok && typeof r.value === 'string' && globMatch(statement.pattern, r.value);
    }
    case 'not':
      return !evaluate(statement.statement, value);
    case 'and':
      return statement.statements.every((s) => evaluate(s, value));
    case 'or':
      return (
        statement.statements.length === 0 || statement.statements.some((s) => evaluate(s, value))
      );
    case 'all':
    case 'any': {
      const r = resolveSelector(statement.selector, value);
      if (!r.ok) return false;
      const elements = Array.isArray(r.value)
        ? r.value
        : isMap(r.value)
          ? Object.values(r.value)
          : null;
      if (!elements) return false;
      if (statement.op === 'all') return elements.every((e) => evaluate(statement.statement, e));
      return elements.length === 0 || elements.some((e) => evaluate(statement.statement, e));
    }
  }
};

const compare = (op: '<' | '<=' | '>' | '>=', a: number, b: number): boolean => {
  switch (op) {
    case '<':
      return a < b;
    case '<=':
      return a <= b;
    case '>':
      return a > b;
    case '>=':
      return a >= b;
  }
};

/** Deep equality over the IPLD data model. */
export const ipldEquals = (a: IpldValue, b: IpldValue): boolean => {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  const cidA = CID.asCID(a);
  const cidB = CID.asCID(b);
  if (cidA || cidB) return cidA !== null && cidB !== null && cidA.equals(cidB);
  if (a instanceof Uint8Array || b instanceof Uint8Array) {
    return (
      a instanceof Uint8Array &&
      b instanceof Uint8Array &&
      a.length === b.length &&
      a.every((x, i) => x === b[i])
    );
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((x, i) => ipldEquals(x, b[i]!))
    );
  }
  const mapA = a as { [key: string]: IpldValue };
  const mapB = b as { [key: string]: IpldValue };
  const keys = Object.keys(mapA);
  return (
    keys.length === Object.keys(mapB).length &&
    keys.every((k) => Object.hasOwn(mapB, k) && ipldEquals(mapA[k]!, mapB[k]!))
  );
};

/**
 * Glob matching with one special character, `*`, matching any run of
 * characters; `\*` is a literal asterisk and every other character,
 * whitespace included, matches only itself.
 */
export const globMatch = (pattern: string, text: string): boolean => {
  // Split into literal chunks around unescaped wildcards.
  const chunks: string[] = [''];
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] === '\\' && pattern[i + 1] === '*') {
      chunks[chunks.length - 1] += '*';
      i++;
    } else if (pattern[i] === '*') {
      chunks.push('');
    } else {
      chunks[chunks.length - 1] += pattern[i];
    }
  }
  const first = chunks[0]!;
  const last = chunks[chunks.length - 1]!;
  if (chunks.length === 1) return text === first;
  if (!text.startsWith(first)) return false;
  let pos = first.length;
  for (const chunk of chunks.slice(1, -1)) {
    const at = text.indexOf(chunk, pos);
    if (at === -1) return false;
    pos = at + chunk.length;
  }
  return text.length - pos >= last.length && text.endsWith(last);
};
