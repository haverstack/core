import type {
  StackRecord,
  StackType,
  RecordVersion,
  Association,
  Permission,
  ValidationError,
  SchemaDriftViolation,
  StackErrorCode,
  AdapterCapabilities,
} from '@haverstack/core';
import {
  StackError,
  StackValidationError,
  StackPermissionError,
  StackNotFoundError,
  StackConflictError,
  StackVersionConflictError,
  StackMigrationError,
  StackQueryError,
  StackSchemaDriftError,
  StackPayloadTooLargeError,
} from '@haverstack/core';

export type WireRecord = {
  id: string;
  typeId: string;
  createdAt: string;
  updatedAt: string;
  content: Record<string, unknown>;
  version: number;
  parentId?: string;
  entityId?: string;
  appId?: string;
  principalId?: string;
  deletedAt?: string;
  permissions?: Permission[];
  associations?: Association[];
};

export type WireType = {
  id: string;
  baseId: string;
  version: number;
  name: string;
  schema: Record<string, unknown>;
  schemaHash: string;
  migratesFrom?: string;
  createdAt: string;
};

export type WireVersion = {
  version: number;
  typeId: string;
  content: Record<string, unknown>;
  updatedAt: string;
  entityId?: string;
  associations?: Association[];
  permissions?: Permission[];
};

export function serializeRecord(r: StackRecord): WireRecord {
  const w: WireRecord = {
    id: r.id,
    typeId: r.typeId,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    content: r.content,
    version: r.version,
  };
  if (r.parentId !== undefined) w.parentId = r.parentId;
  if (r.entityId !== undefined) w.entityId = r.entityId;
  if (r.appId !== undefined) w.appId = r.appId;
  if (r.principalId !== undefined) w.principalId = r.principalId;
  if (r.deletedAt !== undefined) w.deletedAt = r.deletedAt.toISOString();
  if (r.permissions !== undefined) w.permissions = r.permissions;
  if (r.associations !== undefined) w.associations = r.associations;
  return w;
}

export function serializeType(t: StackType): WireType {
  const w: WireType = {
    id: t.id,
    baseId: t.baseId,
    version: t.version,
    name: t.name,
    schema: t.schema as Record<string, unknown>,
    schemaHash: t.schemaHash,
    createdAt: t.createdAt.toISOString(),
  };
  if (t.migratesFrom !== undefined) w.migratesFrom = t.migratesFrom;
  return w;
}

export function serializeVersion(v: RecordVersion): WireVersion {
  const w: WireVersion = {
    version: v.version,
    typeId: v.typeId,
    content: v.content,
    updatedAt: v.updatedAt.toISOString(),
  };
  if (v.entityId !== undefined) w.entityId = v.entityId;
  if (v.associations !== undefined) w.associations = v.associations;
  if (v.permissions !== undefined) w.permissions = v.permissions;
  return w;
}

/** Parse an ISO date string from a wire body, returns undefined if absent or invalid. */
export function parseDate(val: unknown): Date | undefined {
  if (typeof val !== 'string') return undefined;
  const d = new Date(val);
  return isNaN(d.getTime()) ? undefined : d;
}

// -------------------------------------------------------
// Error responses
// -------------------------------------------------------
//
// The round-trip contract for core's typed error taxonomy: a server
// serializes a caught core error via serializeError(), and APIAdapter
// reconstructs the same class via deserializeError(). `code` is the
// authoritative discriminator; status is a transport hint. See
// docs/spec/wire-format.md § Error responses.

/**
 * Alias of core's StackErrorCode: the vocabulary belongs with the classes
 * that carry it, and StackError.code is typed by it, so re-declaring the
 * union here would be a second copy to drift.
 */
export type WireErrorCode = StackErrorCode;

export type WireError = {
  error: {
    code: WireErrorCode;
    message: string;
    /** Field-level validation failures. Only present for code: 'validation'. */
    details?: ValidationError[];
    /** ifVersion/If-Match precondition state. Only present for code: 'version_conflict'. */
    versionConflict?: {
      recordId: string;
      expectedVersion: number;
      actualVersion: number;
    };
    /** The rejected defineType() call's target and violations. Only present for code: 'schema_drift'. */
    schemaDrift?: {
      typeId: string;
      violations: SchemaDriftViolation[];
    };
  };
};

/** Canonical HTTP status for each wire error code. */
export const WIRE_ERROR_STATUS: Record<WireErrorCode, number> = {
  bad_request: 400,
  permission: 403,
  not_found: 404,
  conflict: 409,
  // 412 (not 409): RFC 7232's status for a failed If-Match precondition,
  // and distinct from 'conflict' — StackVersionConflictError is not a
  // StackConflictError subtype (see its doc comment), so each code keeps
  // its own unambiguous status, including for the status-only fallback
  // below.
  version_conflict: 412,
  validation: 422,
  /**
   * No core code path currently produces a StackMigrationError over the
   * wire (migration-graph errors are thrown during client-side migration
   * registration, never as a server response) — this entry exists so a
   * future server-side migration-graph check has a defined status to use.
   */
  migration: 500,
  // Shares 409 with 'conflict', so a schema-drift response without a
  // parseable body degrades to a generic StackConflictError in
  // status-only reconstruction. See docs/spec/wire-format.md § Wire error
  // body.
  schema_drift: 409,
  // 413 is unambiguous — no other wire code shares it — so status-only
  // reconstruction (STATUS_TO_CODE below) recovers this class even from a
  // bodyless response (e.g. a reverse proxy's own request-entity-too-large
  // page, not the server's JSON error body).
  payload_too_large: 413,
};

/**
 * Statuses that unambiguously imply a wire error code, for reconstructing
 * an error from status alone when a response has no parseable wire error
 * body. 500 is deliberately excluded — it would misclassify ordinary
 * server bugs as StackMigrationError. See docs/spec/wire-format.md
 * § Wire error body.
 */
export const STATUS_TO_CODE: Partial<Record<number, WireErrorCode>> = {
  400: 'bad_request',
  403: 'permission',
  404: 'not_found',
  409: 'conflict',
  412: 'version_conflict',
  422: 'validation',
  413: 'payload_too_large',
};

const KNOWN_CODES = new Set<string>(Object.keys(WIRE_ERROR_STATUS));

/** Type guard: does this parsed JSON body look like a WireError? */
export function isWireError(body: unknown): body is WireError {
  if (!body || typeof body !== 'object') return false;
  const err = (body as Record<string, unknown>).error;
  if (!err || typeof err !== 'object') return false;
  const code = (err as Record<string, unknown>).code;
  const message = (err as Record<string, unknown>).message;
  return typeof code === 'string' && KNOWN_CODES.has(code) && typeof message === 'string';
}

/**
 * Convert a thrown core error into its wire response. Used by server
 * implementations. Returns null for anything that isn't a StackError —
 * callers fall back to their own generic error handling, so an ordinary bug
 * stays a bare 500 rather than being dressed as a protocol error.
 */
export function serializeError(err: unknown): { status: number; body: WireError } | null {
  if (!(err instanceof StackError)) return null;
  const error: WireError['error'] = { code: err.code, message: err.message };
  // The three classes carrying structured payload still need instanceof: a
  // literal `code` doesn't narrow a class type to its subclass in TypeScript.
  // Order-independent, since these are leaves with no subtype relation.
  if (err instanceof StackValidationError) {
    error.details = err.errors;
  } else if (err instanceof StackVersionConflictError) {
    error.versionConflict = {
      recordId: err.recordId,
      expectedVersion: err.expectedVersion,
      actualVersion: err.actualVersion,
    };
  } else if (err instanceof StackSchemaDriftError) {
    error.schemaDrift = { typeId: err.typeId, violations: err.violations };
  }
  return { status: WIRE_ERROR_STATUS[err.code], body: { error } };
}

/** Reconstruct the core error a WireError body describes. */
export function deserializeError(body: WireError): Error {
  const { code, message, details, versionConflict, schemaDrift } = body.error;
  switch (code) {
    case 'validation':
      return new StackValidationError(details ?? []);
    case 'permission':
      return new StackPermissionError(message);
    case 'not_found':
      return new StackNotFoundError(message);
    case 'conflict':
      return new StackConflictError(message);
    case 'version_conflict':
      return new StackVersionConflictError(
        message,
        versionConflict?.recordId ?? '',
        versionConflict?.expectedVersion ?? -1,
        versionConflict?.actualVersion ?? -1,
      );
    case 'bad_request':
      return new StackQueryError(message);
    case 'migration':
      return new StackMigrationError(message);
    case 'schema_drift':
      return new StackSchemaDriftError(schemaDrift?.typeId ?? '', schemaDrift?.violations ?? []);
    case 'payload_too_large':
      return new StackPayloadTooLargeError(message);
  }
}

/**
 * Reconstruct a core error from an HTTP status alone (no usable wire error
 * body). Returns null for statuses with no unambiguous code — callers
 * should fall back to a generic adapter-level error.
 */
export function errorForStatus(status: number, message: string): Error | null {
  const code = STATUS_TO_CODE[status];
  return code ? deserializeError({ error: { code, message } }) : null;
}

// -------------------------------------------------------
// Discovery
// -------------------------------------------------------

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
  capabilities: AdapterCapabilities;
  auth?: DiscoveryAuth;
};

/**
 * How a token can be earned here. Optional, and absent means only whatever
 * issuance scheme the server arranged out of band — a client holding a DID
 * credential then has nothing to perform and is told so at open(), rather
 * than discovering it as a 404 partway through a handshake.
 *
 * An object rather than a boolean because issuance is the surface most
 * likely to grow one: a consent flow arrives as another entry here.
 */
export type DiscoveryAuth = {
  methods: AuthMethod[];
};

/** The challenge–response handshake of docs/spec/wire-format.md § Authentication. */
export const AUTH_METHOD_DID_CHALLENGE = 'did-challenge';

export type AuthMethod = typeof AUTH_METHOD_DID_CHALLENGE;

/** Whether a server advertises the DID challenge–response handshake. */
export function supportsDidChallenge(discovery: DiscoveryResponse): boolean {
  return discovery.auth?.methods?.includes(AUTH_METHOD_DID_CHALLENGE) ?? false;
}

// -------------------------------------------------------
// Authentication handshake
// -------------------------------------------------------

/** POST /auth/challenge request. */
export type AuthChallengeRequest = {
  did: string;
};

/** POST /auth/challenge response. */
export type AuthChallengeResponse = {
  /** Opaque, single-use, base64url-charset. Bound to the requested DID. */
  nonce: string;
  expiresAt: string;
};

/** POST /auth/token request. `signature` is base64url. */
export type AuthTokenRequest = {
  did: string;
  nonce: string;
  signature: string;
};

/**
 * POST /auth/token response. Both identities are always present, and this
 * endpoint always reports them equal — a handshake proves key possession,
 * which says nothing about whom that key may act for. The pair is reported
 * anyway so an issuance path that does delegate needs no new shape.
 * See docs/spec/wire-format.md § Authentication.
 */
export type AuthTokenResponse = {
  token: string;
  expiresAt?: string;
  principalId: string;
  subjectId: string;
};

/**
 * Auth failures have their own vocabulary, deliberately outside
 * WireErrorCode: no Stack operation has begun, so none of them is a
 * StackError and none has a class to reconstruct. The split a client acts
 * on is retryable versus fatal — a stale nonce warrants a fresh handshake,
 * a rejected signature never will.
 */
export type WireAuthErrorCode =
  | 'invalid_did'
  | 'unknown_nonce'
  | 'expired_nonce'
  | 'invalid_signature';

export type WireAuthError = {
  error: {
    code: WireAuthErrorCode;
    message: string;
  };
};

export const WIRE_AUTH_ERROR_STATUS: Record<WireAuthErrorCode, number> = {
  // Malformed input, not a rejected credential — there is nothing here to
  // authenticate yet.
  invalid_did: 400,
  unknown_nonce: 401,
  expired_nonce: 401,
  invalid_signature: 401,
};

/** Codes a fresh handshake can resolve. Anything else is fatal to retry. */
const RETRYABLE_AUTH_CODES = new Set<WireAuthErrorCode>(['unknown_nonce', 'expired_nonce']);

const KNOWN_AUTH_CODES = new Set<string>(Object.keys(WIRE_AUTH_ERROR_STATUS));

/** Type guard: does this parsed JSON body look like a WireAuthError? */
export function isWireAuthError(body: unknown): body is WireAuthError {
  if (!body || typeof body !== 'object') return false;
  const err = (body as Record<string, unknown>).error;
  if (!err || typeof err !== 'object') return false;
  const code = (err as Record<string, unknown>).code;
  const message = (err as Record<string, unknown>).message;
  return typeof code === 'string' && KNOWN_AUTH_CODES.has(code) && typeof message === 'string';
}

/** Whether retrying the handshake from a fresh nonce could succeed. */
export function isRetryableAuthError(code: WireAuthErrorCode): boolean {
  return RETRYABLE_AUTH_CODES.has(code);
}

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
