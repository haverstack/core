export type WireMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

export type ConformanceFixture<Req = unknown, Res = unknown> = {
  /** Unique, stable name — usable as a test-case id. */
  name: string;
  /** What this fixture pins down, and why. */
  description: string;
  method: WireMethod;
  /** Request path, e.g. "/records/1hk153x00001/restore/1". */
  path: string;
  /** Request headers this call must send, beyond Authorization (omitted throughout — every fixture assumes a valid bearer token unless its description says otherwise). Absent when the endpoint has none, e.g. If-Match for the ifVersion precondition. */
  requestHeaders?: Record<string, string>;
  /** JSON request body. Absent for bodiless requests. */
  requestBody?: Req;
  /** Expected HTTP status code. */
  responseStatus: number;
  /** Expected JSON response body. Absent for empty (e.g. 204, or a bodyless 401) responses. */
  responseBody?: Res;
};

/**
 * Two or more requests whose *order* is the thing being pinned — where the
 * obligation is that a server changed state, not that it produced a shape.
 *
 * A single request/response pair cannot express "and not a second time",
 * so a server can satisfy every plain fixture while being replayable. That
 * is the gap this exists for, and it is a narrow one: reach for a plain
 * ConformanceFixture unless a step's expected response depends on an
 * earlier step having happened.
 *
 * Steps are ordinary fixtures applied in order against one server, each
 * seeing the state the previous left. Nothing is templated between them —
 * a step that repeats an earlier one repeats it byte for byte, which is
 * what makes a replay fixture a replay rather than a differently-shaped
 * request.
 */
export type ConformanceSequenceFixture = {
  /** Unique, stable name — usable as a test-case id. */
  name: string;
  /** What this sequence pins down, why order matters, and any assumed prior state. */
  description: string;
  steps: ConformanceFixture[];
};
