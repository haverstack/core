/**
 * Discovery
 * -------------------------------------------------------
 * `GET /.well-known/stack` and the protocol version it negotiates. Each
 * optional surface's advertisement lives with that surface — `auth`,
 * `changes`, `installs` — and is only assembled here.
 * See docs/spec/wire-format.md § Discovery.
 */

import { NATIVE_SORT_FIELDS } from '@haverstack/core';
import type { ContentFilterReach, NativeSortField, StackCapabilities } from '@haverstack/core';
import type { DiscoveryAuth } from './auth.js';
import type { DiscoveryChanges } from './change-feed.js';
import type { DiscoveryInstalls } from './installs.js';

/**
 * The wire protocol this package describes. Bump the major when a change
 * would make an older client read a response wrongly; bump the minor for
 * additions an older client can ignore. See docs/spec/wire-format.md
 * § Version negotiation.
 */
export const WIRE_PROTOCOL_VERSION = '1.0';

/** GET /.well-known/stack. See docs/spec/wire-format.md § Discovery. */
export type DiscoveryResponse = {
  version: string;
  entityId: string;
  timezone?: string;
  capabilities?: DiscoveryCapabilities;
  auth?: DiscoveryAuth;
  changes?: DiscoveryChanges;
  installs?: DiscoveryInstalls;
};

/**
 * `capabilities` as it arrives: a foreign server may omit any part, or name
 * a reach or sort field this client has never heard of. Typed loosely on
 * exactly those fields, so the checks normalizeCapabilities() makes read as
 * checks rather than casts. See docs/spec/wire-format.md § Discovery.
 */
export type DiscoveryCapabilities = {
  filter?: {
    content?: string;
    contentPresent?: boolean;
    contentByType?: number | null;
    search?: boolean;
  };
  sort?: { fields?: string[]; contentField?: boolean; contentFieldByType?: number | null };
  limits?: { attachmentBytes?: number | null; contentBytes?: number | null };
};

const CONTENT_FILTER_REACHES = new Set<string>(['none', 'field', 'path']);
const SORT_FIELDS: ReadonlySet<string> = new Set(NATIVE_SORT_FIELDS);

/**
 * Resolves anything absent, malformed or unrecognized to the least capable
 * value it could stand for — one rule, applied once, rather than a default
 * per key at each call site. `null` is the permissive reading, and only
 * where it is stated: a limit the client cannot pre-check, whose server
 * still answers 413, or a cap with no limit. See
 * docs/spec/adapters.md § Adapter capabilities.
 */
export function normalizeCapabilities(
  capabilities: DiscoveryCapabilities | undefined,
): StackCapabilities {
  const filter = capabilities?.filter;
  const sort = capabilities?.sort;
  const limits = capabilities?.limits;
  const reach = CONTENT_FILTER_REACHES.has(filter?.content as string)
    ? (filter?.content as ContentFilterReach)
    : 'none';
  // The per-Type shapes travel in the POST /records/query body, which a
  // server reaching no content does not serve.
  const cap = (value: unknown): number | null => (reach === 'none' ? 0 : capOrZero(value));
  return {
    filter: {
      content: reach,
      contentPresent: filter?.contentPresent === true,
      contentByType: cap(filter?.contentByType),
      search: filter?.search === true,
    },
    sort: {
      fields: (sort?.fields ?? []).filter((f): f is NativeSortField => SORT_FIELDS.has(f)),
      contentField: sort?.contentField === true,
      contentFieldByType: cap(sort?.contentFieldByType),
    },
    limits: {
      attachmentBytes: finiteOrNull(limits?.attachmentBytes),
      contentBytes: finiteOrNull(limits?.contentBytes),
    },
  };
}

/**
 * A cap on keys, `null` — no limit — where the server says so, or 0 —
 * declined — for anything else that isn't a non-negative integer.
 */
const capOrZero = (value: unknown): number | null => {
  if (value === null) return null;
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : 0;
};

/** A ceiling this client can compare against, or null for "cannot pre-check". */
const finiteOrNull = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

/** Splits a MAJOR.MINOR protocol version. Returns null if it isn't one. */
export function parseProtocolVersion(version: string): { major: number; minor: number } | null {
  const match = /^(\d+)\.(\d+)$/.exec(version);
  return match ? { major: Number(match[1]), minor: Number(match[2]) } : null;
}

/**
 * Majors must match; minors never have to. A higher server minor is additive
 * fields this client ignores, and a higher client minor is optional fields
 * the server may omit — neither can make a response read wrongly, which is
 * the only thing a major bump signals.
 */
export function isProtocolCompatible(version: string, against = WIRE_PROTOCOL_VERSION): boolean {
  const server = parseProtocolVersion(version);
  const client = parseProtocolVersion(against);
  return server !== null && client !== null && server.major === client.major;
}
