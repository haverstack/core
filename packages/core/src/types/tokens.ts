/**
 * Bearer-token issuance and lookup for server implementations.
 */

import type { EntityId, Session } from './ids.js';

/**
 * The Session a token names, with `principalId` always populated, equal
 * to `subjectId` on an undelegated token, so a server reading one never
 * has to default it. A delegated token keeps the chain it was issued on,
 * validated again on each request. Passes to `Stack.asActor()` as is.
 * See docs/spec/wire-format.md § The session a token names.
 */
export type TokenSession = Session & { principalId: EntityId };

export type TokenInfo = TokenSession & {
  id: string;
  label?: string;
  createdAt: Date;
  expiresAt?: Date;
};

/**
 * Bearer-token issuance and lookup for servers — standalone, not a slot on
 * StackAdapter. createToken() trusts its caller: the handshake verifies the
 * principal's DID first, and a differing `subjectId` comes from a signed
 * delegation the server verified, or is asserted by the owner out of band.
 * Store tokens outside the portable stack file.
 * See docs/spec/wire-format.md § Authentication.
 */
export interface StackTokenStore {
  createToken(
    session: Session,
    opts?: { label?: string; expiresAt?: Date },
  ): Promise<{
    id: string;
    token: string;
  }>;
  lookupToken(token: string): Promise<TokenSession | null>;
  listTokens(): Promise<TokenInfo[]>;
  revokeToken(id: string): Promise<void>;
}
