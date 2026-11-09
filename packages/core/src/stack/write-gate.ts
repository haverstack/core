/**
 * Stack — Write gates
 * -------------------------------------------------------
 * A refusal a caller above `Stack` asks of the record a write addresses,
 * handed to `Stack` so it is asked of the read the write lands on. An
 * element-set write reads again each time its set moves, and a gate asked
 * once, of an earlier read, would admit the retried write on authority the
 * record no longer gives. `ScopedStack` passes its authority gates this way.
 *
 * Internal by construction, like `WRITE_EXPECTATION`: the gate travels under
 * a module-private symbol key that `StackClient` never declares and the wire
 * never carries. A gate can only refuse, so a caller holding the key gains
 * nothing by passing one. See docs/spec/versioning.md § Element-set writes
 * compare the set they read.
 */

import type { StackRecord } from '../types/index.js';

export const WRITE_GATE = Symbol('haverstack.writeGate');

/** Throws to refuse the write; asked once per read, after the family check. */
export type WriteGate = (record: StackRecord) => Promise<void>;

export type GateOptions = { readonly [WRITE_GATE]?: WriteGate };
