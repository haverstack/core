/**
 * Head
 * -------------------------------------------------------
 * `GET /head`: where the store's writes stand, for the owner acting alone.
 * Two equal heads mean nothing was written between them, which is how a
 * copy knows it read one moment. See docs/spec/wire-format.md § Head.
 */

/**
 * Whether a server reports its head at `GET /head`. Absent means it does
 * not, and `APIAdapter` then has no `head()`. An object for the same reason
 * `changes` is one.
 */
export type DiscoveryHead = {
  read: boolean;
};

/** Whether a server advertises `GET /head`. */
export function supportsHead(discovery: { head?: DiscoveryHead }): boolean {
  return discovery.head?.read === true;
}

/** The response body of `GET /head`: opaque, compared only for equality. */
export type WireHeadResponse = {
  head: string;
};
