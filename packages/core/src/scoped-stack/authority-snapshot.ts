/**
 * Authority snapshot
 * -------------------------------------------------------
 * The authority one request acts with, read once: the `_grant` Records,
 * the roles the subject holds on rosters, the families the stack defines,
 * the session's delegation as validated now, and the reach each verb
 * builds from them — each loaded on first use and shared after, so an operation
 * reads each at most once however many Records it decides. An operation
 * takes its own and drops it when done; a subscription holds one for its
 * life. Events clear what Record writes move; on each use the snapshot
 * checks the two inputs no event carries, the stack's defined Types and
 * the clock. See docs/spec/access-control.md § Reach.
 */

import { Lazy } from '../lazy.js';
import { SYSTEM_TYPES } from '../types/index.js';
import type { RosterRoles } from '../access.js';
import type { Reach, RecordVerb, StackRecord, VerifiedDelegation } from '../types/index.js';

export type AuthoritySources = {
  grants: () => Promise<StackRecord[]>;
  roles: RosterRoles;
  families: () => Promise<ReadonlySet<string>>;
  /** Moves whenever a Type is defined — see Stack.typeGeneration. */
  typeGeneration: () => number;
  delegation: () => Promise<VerifiedDelegation | null>;
  reach: (verb: RecordVerb, snapshot: AuthoritySnapshot) => Promise<Reach>;
};

export class AuthoritySnapshot {
  private readonly grantSet: Lazy<StackRecord[]>;
  private readonly roleSet: Lazy<Awaited<ReturnType<RosterRoles>>>;
  private readonly familySet: Lazy<ReadonlySet<string>>;
  /** The type generation the families were read at. */
  private familiesAt: number | null = null;
  private readonly delegationSet: Lazy<VerifiedDelegation | null>;
  /** When the loaded delegation stops being valid, so a held snapshot never outlives it. */
  private delegationExpiry: number | null = null;
  private readonly reaches = new Map<RecordVerb, Lazy<Reach>>();

  constructor(private readonly sources: AuthoritySources) {
    this.grantSet = new Lazy(sources.grants);
    this.roleSet = new Lazy(sources.roles);
    this.familySet = new Lazy(async () => {
      this.familiesAt = sources.typeGeneration();
      return sources.families();
    });
    this.delegationSet = new Lazy(async () => {
      const delegation = await sources.delegation();
      this.delegationExpiry = delegation?.expiresAt?.getTime() ?? null;
      return delegation;
    });
  }

  readonly grants = (): Promise<StackRecord[]> => this.grantSet.get();
  readonly roles: RosterRoles = () => this.roleSet.get();
  readonly families = (): Promise<ReadonlySet<string>> => this.familySet.get();
  readonly delegation = (): Promise<VerifiedDelegation | null> => this.delegationSet.get();

  reach(verb: RecordVerb): Promise<Reach> {
    if (this.delegationExpiry !== null && Date.now() > this.delegationExpiry) {
      this.clearDelegation();
    }
    if (this.familiesAt !== null && this.familiesAt !== this.sources.typeGeneration()) {
      this.familySet.clear();
      this.familiesAt = null;
      this.reaches.clear();
    }
    let reach = this.reaches.get(verb);
    if (!reach) {
      reach = new Lazy(() => this.sources.reach(verb, this));
      this.reaches.set(verb, reach);
    }
    return reach.get();
  }

  /**
   * Drop whatever a change to `typeFamily` can move, and every reach built
   * from it. A load already in flight still answers the event that started
   * it, which precedes the write; the next question loads afresh.
   */
  invalidateFor(typeFamily: string): void {
    if (typeFamily === SYSTEM_TYPES.GRANT) this.grantSet.clear();
    else if (typeFamily === SYSTEM_TYPES.GROUP) this.roleSet.clear();
    else if (typeFamily === SYSTEM_TYPES.REVOCATION) return this.clearDelegation();
    else return;
    this.reaches.clear();
  }

  private clearDelegation(): void {
    this.delegationSet.clear();
    this.delegationExpiry = null;
    this.reaches.clear();
  }
}
