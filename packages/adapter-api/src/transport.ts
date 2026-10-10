/**
 * HTTP transport helpers
 * -------------------------------------------------------
 * The request-level rules every endpoint shares: which URLs may be
 * opened, how an ID becomes a path segment, and what a response body is
 * owed. See docs/spec/wire-format.md § Success responses.
 */

import { StackBadRequestError } from '@haverstack/core';
import type { StackRecord } from '@haverstack/core';
import type { WireRecord } from '@haverstack/wire-types';
import { APIAdapterError, APIAdapterConnectionError } from './errors.js';
import { parseRecord } from './parse.js';

/**
 * Whether a URL's host is the local machine, where plaintext has no
 * network to be observed on. Matched by host rather than by name
 * resolution: a name that merely resolves to a loopback address today is
 * not a promise about where the next request goes.
 */
export const isLoopbackUrl = (url: string): boolean => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return host === 'localhost' || host === '::1' || /^127\.\d+\.\d+\.\d+$/.test(host);
};

/**
 * One caller-supplied value as one URL path segment, so an ID can never
 * reach a different endpoint than the one the method names. `.` and `..`
 * are refused outright: URL parsing collapses them even percent-encoded.
 */
export const pathSegment = (value: string | number): string => {
  const s = String(value);
  if (s === '' || s === '.' || s === '..') {
    throw new StackBadRequestError(`Invalid path segment ${JSON.stringify(s)}`);
  }
  return encodeURIComponent(s);
};

/**
 * fetch(), with a transport failure reported as this adapter's own error.
 * `baseUrl` names the server in the message even when `url` is a longer
 * path under it — what failed is the connection, not the endpoint.
 */
export const fetchOrThrow = async (
  baseUrl: string,
  url: string,
  init?: RequestInit,
): Promise<Response> => {
  try {
    return await fetch(url, init);
  } catch (err) {
    throw new APIAdapterConnectionError(baseUrl, err);
  }
};

/**
 * The headers every request carries: the bearer token when there is one —
 * an unauthenticated adapter sends no empty `Bearer` — plus whatever the
 * endpoint adds.
 */
export const authHeaders = (
  token: string | undefined,
  extra?: Record<string, string>,
): Record<string, string> => {
  const headers: Record<string, string> = { ...extra };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return headers;
};

/**
 * A response body as JSON, or undefined when there is none to read. For
 * error paths only: a failed response is under no obligation to carry a
 * parseable body, and the status still has to be reported when it doesn't.
 */
export const readJsonBody = async (res: Response): Promise<unknown> => {
  try {
    return await res.json();
  } catch {
    return undefined;
  }
};

/**
 * The head of an unparseable body: enough to recognize what answered,
 * without pasting a whole error page into an exception message.
 */
const bodyExcerpt = (text: string, limit = 120): string => {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > limit ? `${collapsed.slice(0, limit)}…` : collapsed;
};

/**
 * The body of a successful response, or `undefined` when it carried none
 * — which only the call site can judge. A non-empty body that will not
 * parse is the server's fault wherever it lands, so it is reported here.
 * See docs/spec/wire-format.md § Success responses.
 */
export const parseJsonBody = async (
  res: Response,
  method: string,
  path: string,
): Promise<unknown> => {
  const text = await res.text();
  if (text.trim() === '') return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw new APIAdapterError(
      `${method} ${path} answered ${res.status} with a body that is not JSON. ` +
        `The response began: ${bodyExcerpt(text)}`,
      res.status,
    );
  }
};

/**
 * A Record body a mutation is required to answer with. Every mutation that
 * bumps `version` returns one, so an empty body is a foreign server that
 * has not implemented the wire format — reported as such rather
 * than as a property access on `undefined`.
 * See docs/spec/wire-format.md § Records.
 */
export const requireRecordBody = (
  raw: WireRecord | null | undefined,
  endpoint: string,
): StackRecord => {
  if (!raw) {
    throw new APIAdapterError(
      `${endpoint} answered with no Record body. Every mutation that bumps a version must ` +
        'return the record it produced.',
    );
  }
  return parseRecord(raw);
};

const emptyBodyError = (endpoint: string): APIAdapterError =>
  new APIAdapterError(
    `${endpoint} answered with no body. A 200 carries the body its endpoint returns; ` +
      'an absent record, version or type is a 404.',
  );

/**
 * The body a read with no "absent" case is owed, reported rather than
 * dereferenced when it is missing.
 * See docs/spec/wire-format.md § Success responses.
 */
export const requireBody = <T>(raw: T | null | undefined, endpoint: string): T => {
  if (raw == null) throw emptyBodyError(endpoint);
  return raw;
};

/**
 * The same, for a read that can answer "not there": only the `null` this
 * adapter produced from a `404` travels, never an empty body.
 * See docs/spec/wire-format.md § Success responses.
 */
export const requireNullableBody = <T>(raw: T | null | undefined, endpoint: string): T | null => {
  if (raw === undefined) throw emptyBodyError(endpoint);
  return raw;
};

/**
 * A success body read whole: parsed, and required to be there. For the
 * responses that are not routed through APIAdapter's request helpers —
 * discovery and the handshake. See docs/spec/wire-format.md § Success responses.
 */
export const successBody = async <T>(res: Response, method: string, path: string): Promise<T> =>
  requireBody((await parseJsonBody(res, method, path)) as T | undefined, `${method} ${path}`);
