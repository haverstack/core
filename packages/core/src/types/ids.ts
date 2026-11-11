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
 * unlike a RecordId. did:key is the mandatory floor method (see did/did.ts).
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

/**
 * What a request can do to a Record: the grant actions without `-own`/`-any`.
 * Each builds its own reach, and a signed delegation authorizes them by name.
 */
export type RecordVerb = 'create' | 'read' | 'update' | 'delete';

/**
 * What a delegation verifier reports of a chain it accepted: whom it acts
 * for, through whom, until when, what it lets the principal do, and who
 * issued each link. See docs/spec/access-control.md § Signed delegations.
 */
export type VerifiedDelegation = {
  subjectId: EntityId;
  principalId: EntityId;
  /** The chain's earliest expiry, or null if no link expires. */
  expiresAt: Date | null;
  /** Whether the principal may `verb` Records of the family `baseId` for its subject. */
  allows: (verb: RecordVerb, baseId: BaseId) => boolean;
  /** Each link, root first: the CID naming it and the identity that issued it. */
  links: readonly { cid: string; issuerId: EntityId }[];
};

/**
 * What core asks of a chain beside its own rules. `timeBounds` is false
 * when the chain names a delegation being revoked, which may be withdrawn
 * before it starts or after it ends.
 */
export type DelegationCheck = {
  /** Whether the delegation `cid` names is revoked on this stack. */
  isRevoked: (cid: string) => Promise<boolean>;
  timeBounds: boolean;
};

/**
 * Validates an encoded delegation chain, root first, throwing to refuse it.
 * Core supplies the revocation check, so the stack's own `_revocation`
 * Records always apply. `@haverstack/ucan`'s delegationVerifier() is one.
 */
export type DelegationVerifier = (
  chain: readonly Uint8Array[],
  check: DelegationCheck,
) => Promise<VerifiedDelegation>;

/**
 * An Actor as a request presents it: the identities, and the signed
 * delegation chain, root first, a delegated session rests on. The chain
 * never reaches a Record's attribution. Passes to `Stack.asActor()`.
 * See docs/spec/access-control.md § Signed delegations.
 */
export type Session = Actor & { delegationChain?: readonly Uint8Array[] };
