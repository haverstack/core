/**
 * Authority snapshot
 * -------------------------------------------------------
 * The authority one request acts with, read once: the `_grant` Records,
 * the roles the subject holds on rosters, and the reach each verb builds
 * from them — each loaded on first use and shared after, so an operation
 * reads each at most once however many Records it decides. An operation
 * takes its own and drops it when done; a subscription holds one for its
 * life, which is only safe because every write that can move it arrives as
 * an event that clears it. See docs/spec/access-control.md § Reach.
 */

import { Lazy } from '../lazy.js';
import { SYSTEM_TYPES } from '../types/index.js';
import type { RosterRoles } from '../access.js';
import type { BaseId, Reach, StackRecord } from '../types/index.js';

/** The verbs a reach is built for: one per thing a request can do to a Record. */
export type ReachVerb = 'create' | 'read' | 'update' | 'delete';

export type AuthoritySources = {
  grants: () => Promise<StackRecord[]>;
  roles: RosterRoles;
  reach: (verb: ReachVerb, snapshot: AuthoritySnapshot) => Promise<Reach<BaseId>>;
};

export class AuthoritySnapshot {
  private readonly grantSet: Lazy<StackRecord[]>;
  private readonly roleSet: Lazy<Awaited<ReturnType<RosterRoles>>>;
  private readonly reaches = new Map<ReachVerb, Lazy<Reach<BaseId>>>();

  constructor(private readonly sources: AuthoritySources) {
    this.grantSet = new Lazy(sources.grants);
    this.roleSet = new Lazy(sources.roles);
  }

  readonly grants = (): Promise<StackRecord[]> => this.grantSet.get();
  readonly roles: RosterRoles = () => this.roleSet.get();

  reach(verb: ReachVerb): Promise<Reach<BaseId>> {
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
    else return;
    this.reaches.clear();
  }
}
