/**
 * Canned reads over a stack
 * -------------------------------------------------------
 * The internal call sites that need every match rather than a page —
 * grant checks, attachment cleanup, DID resolution — expressed once. Most
 * take the query function to run against, so the same read serves an
 * unscoped `Stack` and a permission-filtered `ScopedStack` without either
 * knowing which it got; the `_app` and `_install` reads must see past
 * deletion and listing, so they take the unscoped `Stack` itself. Also the
 * page-size bounds both classes' query() applies.
 *
 * None of these is a public API.
 */

import { StackBadRequestError } from '../errors.js';
import { filtersContent } from '../query-validation.js';
import { SYSTEM_TYPES } from '../types/index.js';
import type { Stack } from './stack.js';
import type {
  AppContent,
  EntityContent,
  EntityId,
  GrantContent,
  InstallContent,
  QueryResult,
  StackQuery,
  StackRecord,
} from '../types/index.js';

/** The page size query() answers with when the caller names none. */
export const DEFAULT_QUERY_LIMIT = 50;
/** The largest page query() returns, whatever the caller asks for. */
export const MAX_QUERY_LIMIT = 1000;

/**
 * Walks `cursor` to exhaustion for the internal call sites that need every
 * match (grant checks, attachment cleanup) — query() itself always
 * paginates. Throws StackBadRequestError past `max` rather than silently
 * truncating a runaway scan. Not a public API.
 */
export async function queryAllPages(
  run: (query: StackQuery) => Promise<QueryResult>,
  query: StackQuery,
  max = QUERY_ALL_MAX,
): Promise<StackRecord[]> {
  const records: StackRecord[] = [];
  let cursor = query.cursor;
  do {
    const page = await run({ ...query, cursor });
    records.push(...page.records);
    if (records.length > max) {
      throw new StackBadRequestError(
        `queryAllPages: exceeded max of ${max} records without exhausting the cursor`,
      );
    }
    cursor = page.cursor ?? undefined;
  } while (cursor);
  return records;
}

/** Safety cap for queryAllPages() — generous for personal-stack scale. */
const QUERY_ALL_MAX = 10_000;

/**
 * Cursor-walks `run(query)` looking for the first record matching
 * `predicate`, short-circuiting on a match. Same bounded-scan discipline
 * as queryAllPages(): a match past page one is still found, and a
 * non-terminating scan throws StackBadRequestError.
 */
export async function findFirstMatch(
  run: (query: StackQuery) => Promise<QueryResult>,
  query: StackQuery,
  predicate: (record: StackRecord) => boolean | Promise<boolean>,
  max = QUERY_ALL_MAX,
): Promise<StackRecord | undefined> {
  let cursor = query.cursor;
  let totalFetched = 0;
  do {
    const page = await run({ ...query, cursor });
    totalFetched += page.records.length;
    if (totalFetched > max) {
      throw new StackBadRequestError(
        `findFirstMatch: exceeded max of ${max} records without exhausting the cursor`,
      );
    }
    for (const record of page.records) {
      if (await predicate(record)) return record;
    }
    cursor = page.cursor ?? undefined;
  } while (cursor);
  return undefined;
}

/**
 * Shared implementation behind Stack.getEntityByDid() and
 * ScopedStack.getEntityByDid() — see docs/spec/identity.md § DID bindings
 * for the matching rules. `includeUnlisted` is a parameter rather than
 * hardcoded, so a caller not permitted to set it can omit it instead of
 * having query() throw.
 */
export async function lookupEntityByDid(
  run: (query: StackQuery) => Promise<QueryResult>,
  did: EntityId,
  canFilterContent: boolean,
  includeUnlisted: boolean,
): Promise<StackRecord | null> {
  const record = await findFirstMatch(
    run,
    {
      filter: {
        baseId: SYSTEM_TYPES.ENTITY,
        includeDeleted: true,
        ...(includeUnlisted && { includeUnlisted: true }),
        ...(canFilterContent && { content: { did } }),
      },
    },
    (r) => (r.content as EntityContent).did === did,
  );
  return record ?? null;
}

/**
 * The `_app` card claiming `did`, deleted and unlisted included — the
 * binding rules make it single-valued. Takes the unscoped Stack, since no
 * scoped view may read past deletion and listing for everyone.
 * See docs/spec/identity.md § DID bindings.
 */
export function findAppCardByDid(stack: Stack, did: EntityId): Promise<StackRecord | undefined> {
  return findFirstMatch(
    (q) => stack.query(q),
    {
      filter: {
        baseId: SYSTEM_TYPES.APP,
        includeDeleted: true,
        includeUnlisted: true,
        ...(filtersContent(stack.capabilities) && { content: { did } }),
      },
    },
    (r) => (r.content as AppContent).did === did,
  );
}

/**
 * Every `_install` Record, deleted and unlisted included — a deleted
 * install keeps its claims. Takes the unscoped Stack, as findAppCardByDid().
 */
export async function loadInstallRecords(
  stack: Stack,
): Promise<(StackRecord & { content: InstallContent })[]> {
  const records = await queryAllPages((q) => stack.query(q), {
    filter: { baseId: SYSTEM_TYPES.INSTALL, includeDeleted: true, includeUnlisted: true },
  });
  return records as (StackRecord & { content: InstallContent })[];
}

/**
 * Every `_grant` Record, cursor-walked through an unscoped query: a grant
 * decides who may read, so it can't sit behind a read check. Unlisted ones
 * count, as listing decides nothing about what a grant confers; deleted
 * ones don't, as soft-deleting is revoking. See docs/spec/unlisted.md.
 */
export async function loadGrantRecords(
  run: (query: StackQuery) => Promise<QueryResult>,
): Promise<(StackRecord & { content: GrantContent })[]> {
  const records = await queryAllPages(run, {
    filter: { typeId: `${SYSTEM_TYPES.GRANT}@1`, includeUnlisted: true },
  });
  return records as (StackRecord & { content: GrantContent })[];
}
