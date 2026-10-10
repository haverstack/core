/**
 * Identifiers, and the Actor that pairs two of them.
 */

/**
 * Crockford base-32 encoded ID — time-sortable, unique within a stack.
 * Format: 9-char timestamp prefix + 3-char random suffix = 12 chars total.
 * Human-readable and URL-safe. Uniqueness is within-stack only;
 * cross-stack references must include a stackUrl to disambiguate.
 */
export type RecordId = string;

/** Namespaced, versioned type identifier e.g. "com.example.myapp/note@2" */
export type TypeId = string;

/** A type family: a TypeId without its version, e.g. "com.example.myapp/note" */
export type BaseId = string;

/** Opaque file identifier returned by putBlob() */
export type FileId = string;

/**
 * Reverse-DNS identifier for the software that wrote a Record, e.g.
 * "com.example.myapp" — not a RecordId. Self-reported and never a
 * permission input; `StackRecord.createdBy.principalId` is the verified
 * counterpart.
 * See docs/spec/identity.md § App.
 */
export type AppId = string;

/**
 * Identifies a "who" — a DID string, e.g. "did:key:z6Mk...". A
 * self-certifying identifier that means the same thing in every stack,
 * unlike a RecordId. did:key is the mandatory floor method (see did.ts).
 * See docs/spec/identity.md.
 */
export type EntityId = string;

/**
 * Who did something, and through which principal. `subjectId` is who the
 * act is attributed to; `principalId` is who authenticated, present only
 * when it differs — a delegated app acting for its user. `Stack` stores
 * a `principalId` equal to `subjectId` as absent, so the two spellings of
 * "acted as itself" never diverge. See docs/spec/data-model.md § Actor.
 */
export type Actor = {
  subjectId: EntityId;
  principalId?: EntityId;
};
