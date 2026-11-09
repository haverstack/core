/**
 * Installs
 * -------------------------------------------------------
 * `POST /installs`: an app asking the owner to approve its manifest.
 * See docs/spec/wire-format.md § Installs.
 */

import type { AppManifest } from '@haverstack/core';
import type { WireRecord } from './records.js';

/**
 * Whether a server takes install requests at `POST /installs`. Absent means
 * it does not, and a client says so locally rather than learning it as a
 * 404. An object for the same reason `changes` is one.
 * See docs/spec/wire-format.md § Installs.
 */
export type DiscoveryInstalls = {
  requests: boolean;
};

/** Whether a server advertises `POST /installs`. */
export function supportsInstallRequests(discovery: { installs?: DiscoveryInstalls }): boolean {
  return discovery.installs?.requests === true;
}

/** POST /installs. The key being installed is the session's, never named here. */
export type WireInstallRequest = { manifest: AppManifest };

/**
 * POST /installs answers `pending` (202) while the owner has not approved
 * this manifest for this key, and `installed` (200) once applying it would
 * change nothing.
 */
export type WireInstallResponse =
  | { status: 'pending' }
  | { status: 'installed'; install: WireRecord };
