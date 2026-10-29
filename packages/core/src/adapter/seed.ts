/**
 * Store seeds
 * -------------------------------------------------------
 * A store is created holding one Record, `_config`, which says whose stack
 * it is. A seed is that Record with its history: fresh for a new stack, the
 * source's own for a copy, so the one Record every store starts with is
 * written the way every other Record is. See docs/spec/adapters.md
 * § Construction.
 */

import type { ConfigContent, StackIdentity, StoreSeed } from '../types/index.js';
import { SYSTEM_TYPES } from '../types/index.js';

/** The seed of a stack that has no past: `_config` at version 1, holding `config`. */
export function newStoreSeed(config: ConfigContent): StoreSeed {
  const now = new Date();
  const content: ConfigContent = {
    ownerEntityId: config.ownerEntityId,
    ...(config.timezone !== undefined && { timezone: config.timezone }),
  };
  return {
    config: {
      id: SYSTEM_TYPES.CONFIG,
      typeId: `${SYSTEM_TYPES.CONFIG}@1`,
      createdAt: now,
      updatedAt: now,
      content,
      version: 1,
    },
    history: { versions: [], journal: [] },
  };
}

/** The identity a seed's `_config` holds. */
export function identityOf(seed: StoreSeed): StackIdentity {
  const content = seed.config.content as ConfigContent;
  return { ownerEntityId: content.ownerEntityId };
}
