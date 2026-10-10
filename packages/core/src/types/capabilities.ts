/**
 * What a Stack and its adapter honor, and what a query can be refused for.
 */

import type { NativeSortField } from './query.js';

/**
 * How far into `content` a filter key may reach. The rungs nest, so they
 * are one ordered value rather than booleans that can spell an impossible
 * state. An unrecognized value reads as `'none'`: a refusal is recoverable,
 * an unfiltered superset passed off as filtered is not.
 * See docs/spec/adapters.md § Adapter capabilities.
 */
export type ContentFilterReach =
  /** No `filter.content` and no `filter.contentPresent` at all. */
  | 'none'
  /** Single-segment field names only (`'did'`). */
  | 'field'
  /** Multi-segment paths too (`'emails.value'`). */
  | 'path';

/**
 * What a Stack — and the adapter under it — honors. Every `filter`/`sort`
 * entry is named for the query key it gates, so the capability a query
 * needs is derivable from the query. `limits` are numbers to pre-check
 * against, not features. See docs/spec/adapters.md § Adapter capabilities.
 */
export type StackCapabilities = {
  filter: {
    /**
     * Required `'path'` for local/in-process adapters; a wire adapter may
     * report a shallower rung, driven by the server's discovery response.
     * Stack.query() throws StackBadRequestError rather than silently widening.
     */
    content: ContentFilterReach;
    /**
     * Whether `filter.contentPresent` is honored. Beside the reach ladder,
     * not on it: matching a value promises nothing about answering whether
     * one is there. Meaningful only where `content` is not `'none'`.
     */
    contentPresent: boolean;
    /**
     * Whether `filter.search` is honored. Not a rung on the ladder: a
     * full-text index is a different mechanism from field matching, and
     * neither implies the other. Local adapters may decline it.
     */
    search: boolean;
  };
  sort: {
    /** Which native columns this adapter can order by; see NativeSortField. */
    fields: NativeSortField[];
    /**
     * Whether `sort.contentField` is honored. A boolean rather than names
     * in `fields`: an adapter that sorts by content indexes every top-level
     * scalar. Independent of `filter.content`.
     */
    contentField: boolean;
  };
  /**
   * Ceilings a client can check before spending a request; the server's
   * own limit stays authoritative. `null` means this client cannot
   * pre-check, not that nothing is enforced — local adapters declare it.
   * See docs/spec/adapters.md § Adapter capabilities.
   */
  limits: {
    /** Maximum attachment upload size in bytes. */
    attachmentBytes: number | null;
    /**
     * Maximum serialized size in bytes of a Record's content — a create
     * body or a merge patch. Stack.create()/Stack.mutate() pre-check
     * against it and throw StackPayloadTooLargeError before sending.
     */
    contentBytes: number | null;
  };
};

/**
 * A capability a query can be refused for, as its path into
 * StackCapabilities — the same name the spec and a discovery response
 * use, so an error says which key to look at. `limits` never appears: a
 * ceiling is not something a query can lack.
 */
export type MissingCapability =
  | 'filter.content'
  | 'filter.contentPresent'
  | 'filter.search'
  | 'sort.fields'
  | 'sort.contentField';
