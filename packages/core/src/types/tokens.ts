/**
 * Bearer-token issuance and lookup for server implementations.
 */

import type { EntityId, Actor } from './ids.js';

/**
 * The two identities a token establishes — an Actor whose `principalId` is
 * always populated, equal to `subjectId` on an undelegated token, so a
 * server reading one never has to default it. Passes to `Stack.asActor()`
 * as is. See docs/spec/access-control.md § Delegation: principal and subject.
 */
export type TokenSession = Actor & {
  principalId: EntityId;
};

export type TokenInfo = TokenSession & {
  id: string;
  label?: string;
  createdAt: Date;
  expiresAt?: Date;
};

/**
 * Bearer-token issuance and lookup for servers — standalone, not a slot on
 * StackAdapter. createToken() trusts its caller: the handshake verifies the
 * principal's DID first, and a differing `subjectId` is asserted by the
 * owner out of band. Store tokens outside the portable stack file.
 * See docs/spec/wire-format.md § Authentication.
 */
export interface StackTokenStore {
  createToken(
    actor: Actor,
    opts?: { label?: string; expiresAt?: Date },
  ): Promise<{
    id: string;
    token: string;
  }>;
  lookupToken(token: string): Promise<TokenSession | null>;
  listTokens(): Promise<TokenInfo[]>;
  revokeToken(id: string): Promise<void>;
}
