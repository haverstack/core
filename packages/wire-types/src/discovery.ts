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
  filter?: { content?: string; contentPresent?: boolean; search?: boolean };
  sort?: { fields?: string[]; contentField?: boolean };
  limits?: { attachmentBytes?: number | null; contentBytes?: number | null };
};

const CONTENT_FILTER_REACHES = new Set<string>(['none', 'field', 'path']);
const SORT_FIELDS: ReadonlySet<string> = new Set(NATIVE_SORT_FIELDS);

/**
 * Resolves anything absent, malformed or unrecognized to the least capable
 * value it could stand for — one rule, applied once, rather than a default
 * per key at each call site. A `null` limit is the one permissive reading,
 * since the server's own ceiling still answers 413. See
 * docs/spec/adapters.md § Adapter capabilities.
 */
export function normalizeCapabilities(
  capabilities: DiscoveryCapabilities | undefined,
): StackCapabilities {
  const filter = capabilities?.filter;
  const sort = capabilities?.sort;
  const limits = capabilities?.limits;
  const reach = filter?.content;
  return {
    filter: {
      content: CONTENT_FILTER_REACHES.has(reach as string) ? (reach as ContentFilterReach) : 'none',
      contentPresent: filter?.contentPresent === true,
      search: filter?.search === true,
    },
    sort: {
      fields: (sort?.fields ?? []).filter((f): f is NativeSortField => SORT_FIELDS.has(f)),
      contentField: sort?.contentField === true,
    },
    limits: {
      attachmentBytes: finiteOrNull(limits?.attachmentBytes),
      contentBytes: finiteOrNull(limits?.contentBytes),
    },
  };
}

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
