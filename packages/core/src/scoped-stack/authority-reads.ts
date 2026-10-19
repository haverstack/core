/**
 * Authority reads
 * -------------------------------------------------------
 * The two sets every permission question one request asks is answered
 * from: the `_grant` Records, and the roles the subject holds on rosters.
 * Each is loaded on first use and shared after, so an operation reads each
 * at most once however many Records it decides. An operation holds its own
 * and drops it when done; a subscription holds one for its life, which is
 * only safe because every write that can change either set arrives as an
 * event that drops it. See docs/spec/access-control.md § Who a grant reaches.
 */

import { SYSTEM_TYPES } from '../types/index.js';
import type { GroupRole, RecordId, StackRecord } from '../types/index.js';

export type AuthoritySources = {
  grants: () => Promise<StackRecord[]>;
  roles: () => Promise<ReadonlyMap<RecordId, GroupRole>>;
};

export class AuthorityReads {
  private readonly grantSet: Slot<StackRecord[]>;
  private readonly roleSet: Slot<ReadonlyMap<RecordId, GroupRole>>;

  constructor(sources: AuthoritySources) {
    this.grantSet = new Slot(sources.grants);
    this.roleSet = new Slot(sources.roles);
  }

  readonly grants = (): Promise<StackRecord[]> => this.grantSet.get();
  readonly roles = (): Promise<ReadonlyMap<RecordId, GroupRole>> => this.roleSet.get();

  /**
   * Drop whichever set a change to `typeFamily` can move. A load already in
   * flight still answers the event that started it, which precedes the
   * write; the next question loads afresh.
   */
  invalidateFor(typeFamily: string): void {
    if (typeFamily === SYSTEM_TYPES.GRANT) this.grantSet.clear();
    if (typeFamily === SYSTEM_TYPES.GROUP) this.roleSet.clear();
  }
}

/** One set, loaded on first use. A failed load is not kept, so the next question asks again. */
class Slot<T> {
  private loading: Promise<T> | null = null;

  constructor(private readonly load: () => Promise<T>) {}

  get(): Promise<T> {
    if (this.loading) return this.loading;
    const loading = this.load();
    this.loading = loading;
    loading.catch(() => {
      if (this.loading === loading) this.loading = null;
    });
    return loading;
  }

  clear(): void {
    this.loading = null;
  }
}
